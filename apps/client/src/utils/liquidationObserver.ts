import type { Pricer } from "@morpho-blue-liquidation-bot/pricers";
import {
  formatUnits,
  parseAbi,
  type Account,
  type Address,
  type Chain,
  type Client,
  type Hex,
  type Transport,
} from "viem";
import { getTransactionReceipt, watchContractEvent } from "viem/actions";

import type { NearLiquidationSnapshot } from "./dailyReport.js";
import { MetricsLogger } from "./metrics.js";
import type { TelegramNotifier } from "./telegram.js";

export const morphoBlueLiquidateAbi = parseAbi([
  "event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)",
]);

export interface ObservedLiquidation {
  marketId: Hex;
  caller: Address;
  borrower: Address;
  seizedAssets: bigint;
  repaidAssets: bigint;
  /** True when our own executor placed the trade — excluded from competitor stats. */
  self: boolean;
  /** True when the liquidated position was in our last radar snapshot — false means a coverage gap. */
  radarSeen: boolean;
  gasUsd?: number;
  txHash: Hex;
  blockNumber: bigint;
}

/**
 * Pure record builder: turns a Liquidate log + receipt into an observation.
 * The radar join (`radarSeen`) distinguishes "we watched it tip and lost the
 * race" from "we never had the position" — the key signal for deciding
 * between speed work and coverage work.
 */
export function buildObservedLiquidation(inputs: {
  marketId: Hex;
  caller: Address;
  borrower: Address;
  seizedAssets: bigint;
  repaidAssets: bigint;
  txHash: Hex;
  blockNumber: bigint;
  radarEntries: ReadonlySet<string>;
  selfAddress: Address;
  gasUsd?: number;
}): ObservedLiquidation {
  const self = inputs.caller.toLowerCase() === inputs.selfAddress.toLowerCase();
  const radarSeen = inputs.radarEntries.has(`${inputs.borrower}@${inputs.marketId}`);
  return {
    marketId: inputs.marketId,
    caller: inputs.caller,
    borrower: inputs.borrower,
    seizedAssets: inputs.seizedAssets,
    repaidAssets: inputs.repaidAssets,
    self,
    radarSeen,
    gasUsd: inputs.gasUsd,
    txHash: inputs.txHash,
    blockNumber: inputs.blockNumber,
  };
}

/**
 * Watches Morpho Blue Liquidate events (every liquidation on the chain, by
 * anyone) and records them to metrics as `liquidation_observed` — competitive
 * intel for the daily report: who wins races, at what gas, on which markets,
 * and whether the liquidated position was on our radar.
 */
export class LiquidationObserver {
  private readonly client: Client<Transport, Chain>;
  private readonly morphoAddress: Address;
  private readonly executorAddress: Address;
  private readonly wNative: Address;
  private readonly pricers?: Pricer[];
  private readonly metrics: MetricsLogger;
  private readonly radarEntries: () => ReadonlySet<string>;
  private readonly logTag: string;
  private readonly notifier?: TelegramNotifier;
  private readonly getRadarSnapshot?: () => readonly NearLiquidationSnapshot[];
  private readonly resolveTokenDecimals?: (token: string) => Promise<number | undefined>;
  private readonly getRecentAttempt?: (
    user: Address,
    marketId: Hex,
  ) => { outcome: string; ageMs: number } | undefined;

  private static readonly RETRY_DELAY_MS = 5_000;

  constructor(inputs: {
    watchClient: Client<Transport, Chain>;
    morphoAddress: Address;
    executorAddress: Address;
    wNative: Address;
    pricers?: Pricer[];
    metrics: MetricsLogger;
    radarEntries: () => ReadonlySet<string>;
    logTag: string;
    notifier?: TelegramNotifier;
    getRadarSnapshot?: () => readonly NearLiquidationSnapshot[];
    resolveTokenDecimals?: (token: string) => Promise<number | undefined>;
    getRecentAttempt?: (
      user: Address,
      marketId: Hex,
    ) => { outcome: string; ageMs: number } | undefined;
  }) {
    this.client = inputs.watchClient;
    this.morphoAddress = inputs.morphoAddress;
    this.executorAddress = inputs.executorAddress;
    this.wNative = inputs.wNative;
    this.pricers = inputs.pricers;
    this.metrics = inputs.metrics;
    this.radarEntries = inputs.radarEntries;
    this.logTag = inputs.logTag;
    this.notifier = inputs.notifier;
    this.getRadarSnapshot = inputs.getRadarSnapshot;
    this.resolveTokenDecimals = inputs.resolveTokenDecimals;
    this.getRecentAttempt = inputs.getRecentAttempt;
  }

  start(): void {
    const subscribe = () => {
      const unwatch = watchContractEvent(this.client, {
        address: this.morphoAddress,
        abi: morphoBlueLiquidateAbi,
        eventName: "Liquidate",
        onLogs: (logs) => {
          for (const log of logs) void this.observe(log.args, log.transactionHash, log.blockNumber);
        },
        onError: (error) => {
          unwatch();
          console.error(
            `${this.logTag}liquidation observer error, re-subscribing in ${LiquidationObserver.RETRY_DELAY_MS}ms:`,
            error,
          );
          setTimeout(subscribe, LiquidationObserver.RETRY_DELAY_MS);
        },
      });
    };
    subscribe();
  }

  private async observe(
    args: {
      id?: Hex;
      caller?: Address;
      borrower?: Address;
      repaidAssets?: bigint;
      seizedAssets?: bigint;
    },
    txHash: Hex | undefined,
    blockNumber: bigint | undefined,
  ): Promise<void> {
    try {
      if (
        !args.id ||
        !args.caller ||
        !args.borrower ||
        args.seizedAssets === undefined ||
        args.repaidAssets === undefined ||
        !txHash ||
        blockNumber === undefined
      ) {
        return;
      }

      let gasUsd: number | undefined;
      try {
        const receipt = await getTransactionReceipt(this.client, { hash: txHash });
        gasUsd = await this.gasToUsd(receipt.gasUsed, receipt.effectiveGasPrice);
      } catch (error) {
        console.error(
          `${this.logTag}failed to fetch receipt for observed liquidation ${txHash}:`,
          error,
        );
      }

      const observation = buildObservedLiquidation({
        marketId: args.id,
        caller: args.caller,
        borrower: args.borrower,
        seizedAssets: args.seizedAssets,
        repaidAssets: args.repaidAssets,
        txHash,
        blockNumber,
        radarEntries: this.radarEntries(),
        selfAddress: this.executorAddress,
        gasUsd,
      });
      this.metrics.log({
        type: "liquidation_observed",
        ...observation,
      });
      if (!observation.self) {
        console.log(
          `${this.logTag}🕵️ liquidation by ${observation.caller} on market ${observation.marketId}` +
            (observation.radarSeen ? " (was on our radar)" : " (NOT on our radar)") +
            (gasUsd !== undefined ? `, gas $${gasUsd.toFixed(6)}` : ""),
        );
        if (observation.radarSeen) void this.alertLost(observation);
      } else {
        // Our own trade — the bot's executed alert already covers it.
        return;
      }
    } catch (error) {
      console.error(`${this.logTag}failed to record observed liquidation:`, error);
    }
  }

  /** Notifies subscribers when a position we were watching was taken by a competitor. */
  private async alertLost(observation: ObservedLiquidation): Promise<void> {
    if (!this.notifier) return;
    let debtDisplay: string | undefined;
    const snapshotted = this.getRadarSnapshot?.().find(
      (p) =>
        p.user.toLowerCase() === observation.borrower.toLowerCase() &&
        p.marketId === observation.marketId,
    );
    if (snapshotted && this.resolveTokenDecimals) {
      const decimals = await this.resolveTokenDecimals(snapshotted.loanToken.toLowerCase());
      if (decimals !== undefined)
        debtDisplay = `$${(
          Number(BigInt(observation.repaidAssets)) /
          10 ** decimals
        ).toLocaleString("en-US")}`;
    }
    const attempt = this.getRecentAttempt?.(observation.borrower, observation.marketId);
    await this.notifier.sendLostAlert({
      borrower: observation.borrower,
      marketId: observation.marketId,
      winnerTx: observation.txHash,
      debtDisplay,
      ourAttempt: attempt
        ? `${attempt.outcome} (${Math.round(attempt.ageMs / 1_000)}s ago)`
        : undefined,
    });
  }

  /** Prices gas in USD via the configured pricers. wNative is assumed 18 decimals. */
  private async gasToUsd(gasUsed: bigint, effectiveGasPrice: bigint): Promise<number | undefined> {
    if (!this.pricers || this.pricers.length === 0) return undefined;
    const wei = gasUsed * effectiveGasPrice;
    // Pricers are read-only — the account-typed parameter is a signature formality.
    const client = this.client as Client<Transport, Chain, Account>;
    for (const pricer of this.pricers) {
      try {
        const price = await pricer.price(client, this.wNative);
        if (price === undefined) continue;
        return parseFloat(formatUnits(wei, 18)) * price;
      } catch {
        continue;
      }
    }
    return undefined;
  }
}
