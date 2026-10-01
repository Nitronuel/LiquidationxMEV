import {
  chainConfigs,
  FLASHLOAN_FEE_BPS,
  getChainAddressesWithOverrides,
} from "@morpho-blue-liquidation-bot/config";
import type { DataProvider } from "@morpho-blue-liquidation-bot/data-providers";
import type { LiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import type { Pricer } from "@morpho-blue-liquidation-bot/pricers";
import {
  AccrualPosition,
  type IMarketParams,
  MarketUtils,
  PreLiquidationPosition,
} from "@morpho-org/blue-sdk";
import { executorAbi } from "executooor-viem";
import {
  erc20Abi,
  formatUnits,
  getAddress,
  LocalAccount,
  maxUint256,
  parseUnits,
  type Account,
  type Address,
  type Chain,
  type Client,
  type Hex,
  type Transport,
  type WalletClient,
} from "viem";
import {
  getBlockNumber,
  getGasPrice,
  readContract,
  simulateCalls,
  waitForTransactionReceipt,
  writeContract,
} from "viem/actions";

import {
  MarketsFetchingCooldownMechanism,
  PositionLiquidationCooldownMechanism,
  SimFailureBackoff,
} from "./utils/cooldownMechanisms.js";
import {
  aggregateDailyReport,
  previousUtcDate,
  renderDailyReport,
  type NearLiquidationSnapshot,
} from "./utils/dailyReport.js";
import { fetchWhitelistedVaults } from "./utils/fetch-whitelisted-vaults.js";
import { Flashbots } from "./utils/flashbots.js";
import { LiquidationEncoder } from "./utils/LiquidationEncoder.js";
import { DEFAULT_LIQUIDATION_BUFFER_BPS, WAD, wMulDown } from "./utils/maths.js";
import { MetricsLogger } from "./utils/metrics.js";
import { TelegramNotifier } from "./utils/telegram.js";

const oraclePriceAbi = [
  {
    type: "function",
    name: "price",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** 98% scaled by WAD — safety haircut on venue-capacity-derived seizure caps. */
const WAD_98 = 98n * 10n ** 16n;

export interface LiquidationBotInputs {
  logTag: string;
  chainId: number;
  client: WalletClient<Transport, Chain, Account>;
  wNative: Address;
  vaultWhitelist: Address[] | "morpho-api";
  additionalMarketsWhitelist: Hex[];
  executorAddress: Address;
  treasuryAddress: Address;
  dataProvider: DataProvider;
  liquidityVenues: LiquidityVenue[];
  alwaysRealizeBadDebt: boolean;
  useFlashLoans?: boolean;
  pricers?: Pricer[];
  positionLiquidationCooldownMechanism?: PositionLiquidationCooldownMechanism;
  marketsFetchingCooldownMechanism: MarketsFetchingCooldownMechanism;
  flashbotAccount?: LocalAccount;
  /** Watch every market with active borrows instead of only vault-whitelisted markets. */
  watchAllBorrowMarkets?: boolean;
  /** Include near-liquidation positions (health factor below this value, scaled by WAD) in results. */
  preLiquidationHealthFactorThreshold?: bigint;
  /** Re-read candidate positions directly via RPC multicall between full indexer scans. */
  hotPathRpcReads?: boolean;
  /** Interval between full indexer scans that rebuild the candidate set (ms). */
  fullScanIntervalMs?: number;
  /** Optional JSONL file for baseline metrics (radar snapshots, liquidation outcomes). */
  metricsPath?: string;
  /** Optional Telegram notifier for trade alerts and the UTC-midnight daily report. */
  notifier?: TelegramNotifier;
  /** When true, run the full pipeline but never broadcast — record would-be trades instead. */
  dryRun?: boolean;
  /** Skip liquidations whose sized seizure nets less than this (USD). Requires pricers. */
  minProfitUsdFloor?: number;
  /** Circuit breaker: stop trading for the UTC day after this many losing executions. */
  maxDailyLosses?: number;
  /** Cooldown (ms) applied to a position after a failed simulation. 0/undefined disables. */
  simFailureBackoffMs?: number;
  /** Cooldown (ms) applied to a position after an unprofitable result. 0/undefined disables. */
  skippedUnprofitableBackoffMs?: number;
}

/** Result of the simulate → profit-check → broadcast pipeline. */
interface HandleTxResult {
  outcome: "sim_failed" | "skipped_unprofitable" | "skipped_no_liquidity" | "dry_run" | "executed";
  profitUsd?: number;
  gasUsd?: number;
  error?: string;
  txHash?: Hex;
}

function shortRevertReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : "unknown simulation failure";
  // The interesting part of viem's revert message is the decoded reason on the
  // line(s) after the "reverted with the following reason:" preamble — and the
  // first line carries the function name. Keep both, then clamp.
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const interesting =
    lines.length > 1 ? `${lines[0]} ${lines.slice(1).join(" | ")}` : (lines[0] ?? raw);
  return interesting.length > 300 ? `${interesting.slice(0, 300)}…` : interesting;
}

export class LiquidationBot {
  private logTag: string;
  private chainId: number;
  private client: WalletClient<Transport, Chain, Account>;
  private chainAddresses: ReturnType<typeof getChainAddressesWithOverrides>;
  private wNative: Address;
  private vaultWhitelist: Address[] | "morpho-api";
  private additionalMarketsWhitelist: Hex[];
  private executorAddress: Address;
  private treasuryAddress: Address;
  private dataProvider: DataProvider;
  private liquidityVenues: LiquidityVenue[];
  private pricers?: Pricer[];
  private positionLiquidationCooldownMechanism?: PositionLiquidationCooldownMechanism;
  private marketsFetchingCooldownMechanism: MarketsFetchingCooldownMechanism;
  private flashbotAccount?: LocalAccount;
  private coveredMarkets: Hex[];
  private alwaysRealizeBadDebt: boolean;
  private watchAllBorrowMarkets?: boolean;
  private preLiquidationHealthFactorThreshold?: bigint;
  private hotPathRpcReads?: boolean;
  private fullScanIntervalMs?: number;
  private lastRadarPositions?: string;
  private lastRadarLogAt = 0;
  private radarEntries = new Set<string>();
  private lastRadarSnapshot: NearLiquidationSnapshot[] = [];
  private lastAttempt = new Map<string, { outcome: string; at: number }>();
  private useFlashLoans: boolean;
  private dryRun: boolean;
  private minProfitUsdFloor?: number;
  private maxDailyLosses?: number;
  private lossDay = "";
  private lossCount = 0;
  private noRouteWarned = new Set<string>();
  private decimalsCache = new Map<Address, number>();
  private priceCache = new Map<Address, { price: number; at: number }>();
  private metrics?: MetricsLogger;
  private notifier?: TelegramNotifier;
  private metricsPath?: string;
  private simFailureBackoff?: SimFailureBackoff;
  private unprofitableBackoff?: SimFailureBackoff;

  /** USD prices rarely move meaningfully within seconds; pricers hit external HTTP APIs, so cache briefly to keep the pre-broadcast path fast. */
  private static readonly PRICE_CACHE_TTL_MS = 2_000;

  constructor(inputs: LiquidationBotInputs) {
    this.logTag = inputs.logTag;
    this.metrics = inputs.metricsPath
      ? new MetricsLogger(inputs.metricsPath, inputs.logTag)
      : undefined;
    this.metricsPath = inputs.metricsPath;
    this.notifier = inputs.notifier;
    this.simFailureBackoff = inputs.simFailureBackoffMs
      ? new SimFailureBackoff(inputs.simFailureBackoffMs)
      : undefined;
    this.unprofitableBackoff = inputs.skippedUnprofitableBackoffMs
      ? new SimFailureBackoff(inputs.skippedUnprofitableBackoffMs)
      : undefined;
    this.chainId = inputs.chainId;
    this.client = inputs.client;
    this.chainAddresses = getChainAddressesWithOverrides(inputs.chainId);
    this.wNative = inputs.wNative;
    this.vaultWhitelist = inputs.vaultWhitelist;
    this.additionalMarketsWhitelist = inputs.additionalMarketsWhitelist;
    this.executorAddress = inputs.executorAddress;
    this.treasuryAddress = inputs.treasuryAddress;
    this.dataProvider = inputs.dataProvider;
    this.liquidityVenues = inputs.liquidityVenues;
    this.pricers = inputs.pricers;
    this.positionLiquidationCooldownMechanism = inputs.positionLiquidationCooldownMechanism;
    this.marketsFetchingCooldownMechanism = inputs.marketsFetchingCooldownMechanism;
    this.flashbotAccount = inputs.flashbotAccount;
    this.coveredMarkets = [];
    this.alwaysRealizeBadDebt = inputs.alwaysRealizeBadDebt;
    this.useFlashLoans = inputs.useFlashLoans ?? false;
    this.dryRun = inputs.dryRun ?? false;
    this.minProfitUsdFloor = inputs.minProfitUsdFloor;
    this.maxDailyLosses = inputs.maxDailyLosses;
    this.refreshDailyLosses();
    this.watchAllBorrowMarkets = inputs.watchAllBorrowMarkets;
    this.preLiquidationHealthFactorThreshold = inputs.preLiquidationHealthFactorThreshold;
    this.hotPathRpcReads = inputs.hotPathRpcReads;
    this.fullScanIntervalMs = inputs.fullScanIntervalMs;
  }

  /**
   * One evaluation cycle. The optional read client routes market/position reads
   * (e.g. through a free public RPC to save provider compute units); simulation
   * and broadcasting always use the wallet client.
   */
  async run(readClient?: Client<Transport, Chain>) {
    // Reads don't need an account; simulation/broadcast always use the wallet client.
    const source = (readClient ?? this.client) as Client<Transport, Chain, Account>;
    await this.fetchMarkets(source);

    const { liquidatablePositions, preLiquidatablePositions, nearLiquidatablePositions } =
      await this.dataProvider.fetchLiquidatablePositions(source, this.coveredMarkets, {
        preLiquidationHealthFactorThreshold: this.preLiquidationHealthFactorThreshold,
        hotPathRpcReads: this.hotPathRpcReads,
        fullScanIntervalMs: this.fullScanIntervalMs,
      });

    if (nearLiquidatablePositions && nearLiquidatablePositions.length > 0) {
      // Snapshot refreshes every cycle (not only on fingerprint change) so the
      // /near Telegram command always serves fresh data.
      this.lastRadarSnapshot = nearLiquidatablePositions.map((position) => {
        const marketId = MarketUtils.getMarketId(position.market.params);
        return {
          user: position.user,
          marketId,
          loanToken: position.market.params.loanToken,
          healthFactor: position.healthFactor?.toString() ?? "0",
          collateral: position.collateral.toString(),
          borrowAssets: position.borrowAssets.toString(),
        };
      });
      const fingerprint = nearLiquidatablePositions
        .map((position) => `${position.user}@${MarketUtils.getMarketId(position.market.params)}`)
        .sort()
        .join("|");

      // At one run per ~100ms block, radar logging must be throttled: emit on a
      // change in the position set, plus a periodic heartbeat with the count.
      const now = Date.now();
      if (fingerprint !== this.lastRadarPositions || now - this.lastRadarLogAt > 60_000) {
        console.log(
          `${this.logTag}📡 ${nearLiquidatablePositions.length} positions near liquidation (radar)`,
        );

        if (fingerprint !== this.lastRadarPositions) {
          this.radarEntries = new Set(
            nearLiquidatablePositions.map(
              (position) => `${position.user}@${MarketUtils.getMarketId(position.market.params)}`,
            ),
          );
          for (const position of nearLiquidatablePositions) {
            console.log(
              `${this.logTag}📡 Position ${position.user} in market ${MarketUtils.getMarketId(position.market.params)} health factor ${position.healthFactor}`,
            );
          }

          this.metrics?.log({
            type: "radar",
            count: nearLiquidatablePositions.length,
            positions: nearLiquidatablePositions.map((position) => ({
              user: position.user,
              marketId: MarketUtils.getMarketId(position.market.params),
              healthFactor: position.healthFactor?.toString(),
              collateral: position.collateral.toString(),
              borrowAssets: position.borrowAssets.toString(),
            })),
          });
        }

        this.lastRadarPositions = fingerprint;
        this.lastRadarLogAt = now;
      }
    } else if (this.lastRadarSnapshot.length > 0) {
      this.lastRadarSnapshot = [];
    }

    // Execution is strictly sequential: concurrent broadcasts would race on the
    // account nonce ("nonce too low" / stuck replacements). Detection above is
    // already parallel; only the money-moving stage must be serialized.
    for (const position of liquidatablePositions) {
      await this.liquidate(position);
    }
    for (const position of preLiquidatablePositions) {
      await this.preLiquidate(position);
    }
  }

  /** Current near-liquidation positions as `user@marketId` — used by the liquidation observer for race-loss detection. */
  getRadarEntries(): ReadonlySet<string> {
    return this.radarEntries;
  }

  /** Full near-liquidation radar snapshot for the /near Telegram command. */
  getRadarSnapshot(): readonly NearLiquidationSnapshot[] {
    return this.lastRadarSnapshot;
  }

  /** Our most recent attempt on a position, if it was within the last 30s — links LOST alerts to our failed sims. */
  getRecentAttempt(user: Address, marketId: Hex): { outcome: string; ageMs: number } | undefined {
    const entry = this.lastAttempt.get(`${user}@${marketId}`);
    if (!entry) return undefined;
    const ageMs = Date.now() - entry.at;
    if (ageMs > 30_000) return undefined;
    return { outcome: entry.outcome, ageMs };
  }

  /** Fire-and-forget receipt confirmation: alerts on on-chain success or revert. */
  private async confirmReceipt(txHash: Hex): Promise<void> {
    try {
      const receipt = await waitForTransactionReceipt(this.client, {
        hash: txHash,
        timeout: 30_000,
      });
      if (receipt.status === "success") {
        await this.notifier?.send(`✅ Confirmed in block ${receipt.blockNumber}: ${txHash}`);
      } else {
        await this.notifier?.send(`⚠️ Tx reverted on-chain: ${txHash}`);
      }
    } catch (error) {
      console.error(`${this.logTag}receipt confirmation failed for ${txHash}:`, error);
    }
  }

  private async liquidate(position: AccrualPosition) {
    const marketParams = position.market.params;
    const seizableCollateral = position.seizableCollateral ?? 0n;
    const badDebtPosition = seizableCollateral === position.collateral;

    if (!this.checkCooldown(MarketUtils.getMarketId(marketParams), position.user)) return;

    if (this.isLossLimitReached()) {
      const marketId = MarketUtils.getMarketId(marketParams);
      console.log(
        `${this.logTag}🛑 Skipped ${position.user} on ${marketId} (daily loss limit reached)`,
      );
      this.metrics?.log({
        type: "liquidation",
        outcome: "skipped_loss_limit",
        user: position.user,
        marketId,
      });
      return;
    }

    const { client, executorAddress } = this;

    const encoder = new LiquidationEncoder(executorAddress, client);
    const attemptStart = Date.now();

    const sized = await this.sizeSeizable(
      encoder,
      marketParams,
      seizableCollateral,
      badDebtPosition,
    );
    if (sized === undefined) {
      const marketId = MarketUtils.getMarketId(marketParams);
      console.log(
        `${this.logTag}ℹ️ Skipped ${position.user} on ${marketId} (insufficient venue liquidity)`,
      );
      this.metrics?.log({
        type: "liquidation",
        outcome: "skipped_no_liquidity",
        user: position.user,
        marketId,
        seizableCollateral: seizableCollateral.toString(),
      });
      return;
    }

    const built = this.useFlashLoans
      ? await this.buildFlashLoanLiquidationCalls(position, encoder, sized)
      : await this.buildLiquidationCalls(position, encoder, sized);

    if (built === undefined) return;
    const { calls, flashLoanFee } = built;

    try {
      const { outcome, profitUsd, gasUsd, txHash } = await this.handleTx(
        encoder,
        calls,
        marketParams,
        badDebtPosition,
        flashLoanFee,
      );
      const marketId = MarketUtils.getMarketId(marketParams);
      const latencyMs = Date.now() - attemptStart;
      this.lastAttempt.set(`${position.user}@${marketId}`, { outcome, at: Date.now() });

      if (outcome === "sim_failed") {
        this.simFailureBackoff?.markFailed(marketId, position.user);
      } else if (outcome === "skipped_unprofitable") {
        this.unprofitableBackoff?.markFailed(marketId, position.user);
      }

      if (outcome === "executed" || outcome === "dry_run") {
        this.positionLiquidationCooldownMechanism?.markAttempted(marketId, position.user);
      }

      if (outcome === "executed" && (profitUsd ?? 0) <= 0) {
        this.recordLoss();
      }

      if (outcome === "executed") {
        console.log(`${this.logTag}Liquidated ${position.user} on ${marketId}`);
      } else if (outcome === "dry_run") {
        console.log(
          `${this.logTag}🧪 DRY-RUN valid trade found: ${position.user} on ${marketId} (+$${profitUsd?.toFixed(4)}, gas $${gasUsd?.toFixed(6)})`,
        );
      } else if (outcome === "skipped_unprofitable") {
        console.log(`${this.logTag}ℹ️ Skipped ${position.user} on ${marketId} (not profitable)`);
      }

      {
        this.metrics?.log({
          type: "liquidation",
          outcome,
          user: position.user,
          marketId,
          profitUsd,
          gasUsd,
        });
      }

      if (outcome === "executed") {
        void this.notifier?.sendTradeAlert({
          kind: "liquidation",
          outcome: "executed",
          user: position.user,
          marketId,
          profitUsd,
          gasUsd,
          txHash,
          latencyMs,
        });
        if (txHash) void this.confirmReceipt(txHash);
      }
    } catch (error) {
      console.error(
        `${this.logTag}Failed to liquidate ${position.user} on ${MarketUtils.getMarketId(marketParams)}`,
        error,
      );
      this.recordLoss();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const marketId = MarketUtils.getMarketId(marketParams);
      this.lastAttempt.set(`${position.user}@${marketId}`, { outcome: "failed", at: Date.now() });
      this.metrics?.log({
        type: "liquidation",
        outcome: "failed",
        user: position.user,
        marketId,
        error: errorMessage,
      });
      void this.notifier?.sendTradeAlert({
        kind: "liquidation",
        outcome: "failed",
        user: position.user,
        marketId,
        error: errorMessage,
      });
    }
  }

  private async buildLiquidationCalls(
    position: AccrualPosition,
    encoder: LiquidationEncoder,
    seized: bigint,
  ): Promise<{ calls: Hex[]; flashLoanFee: bigint } | undefined> {
    const marketParams = position.market.params;

    if (!(await this.convertCollateralToLoan(marketParams, seized, encoder))) return;

    encoder.erc20Approve(marketParams.loanToken, this.chainAddresses.morpho, maxUint256);

    encoder.morphoBlueLiquidate(
      this.chainAddresses.morpho,
      {
        loanToken: marketParams.loanToken,
        collateralToken: marketParams.collateralToken,
        oracle: marketParams.oracle,
        irm: marketParams.irm,
        lltv: BigInt(marketParams.lltv),
      },
      position.user,
      seized,
      0n,
      encoder.flush(),
    );
    encoder.erc20Skim(marketParams.loanToken, this.treasuryAddress);

    return { calls: encoder.flush(), flashLoanFee: 0n };
  }

  private async buildFlashLoanLiquidationCalls(
    position: AccrualPosition,
    encoder: LiquidationEncoder,
    seized: bigint,
  ): Promise<{ calls: Hex[]; flashLoanFee: bigint } | undefined> {
    const marketParams = position.market.params;
    const market = position.market;

    const repaidShares = MarketUtils.getLiquidationRepaidShares(seized, market, {
      lltv: marketParams.lltv,
    });
    if (repaidShares === undefined) return;

    // Morpho pulls back `repaidAssets` from the executor during `liquidate`. Borrow
    // a hair more than the estimated amount to absorb interest/price drift between
    // simulation and execution; the excess is handed straight back to the pool.
    const repaidAssets = market.toBorrowAssets(repaidShares, "Up");
    const flashLoanAmount = wMulDown(repaidAssets, WAD + parseUnits("1", 16));

    // Flash-loan callback: approve the liquidation repayment first, liquidate, then
    // sell the seized collateral back into loan tokens to cover the flash loan.
    encoder.erc20Approve(marketParams.loanToken, this.chainAddresses.morpho, maxUint256);

    encoder.morphoBlueLiquidate(
      this.chainAddresses.morpho,
      {
        loanToken: marketParams.loanToken,
        collateralToken: marketParams.collateralToken,
        oracle: marketParams.oracle,
        irm: marketParams.irm,
        lltv: BigInt(marketParams.lltv),
      },
      position.user,
      seized,
      0n,
      [],
    );

    if (!(await this.convertCollateralToLoan(marketParams, seized, encoder))) return;

    // The encoder appends an `approve` for the flash loan repayment (`amount + fee`)
    // as the final callback call.
    const callbackCalls = encoder.flush();

    encoder.morphoBlueFlashLoan(
      this.chainAddresses.morpho,
      marketParams.loanToken,
      flashLoanAmount,
      callbackCalls,
    );
    encoder.erc20Skim(marketParams.loanToken, this.treasuryAddress);

    return {
      calls: encoder.flush(),
      flashLoanFee: wMulDown(flashLoanAmount, parseUnits(FLASHLOAN_FEE_BPS.toString(), 14)),
    };
  }

  /**
   * Caps the buffered seizure at what the routing venue can actually pay out
   * right now (vault idle balance, pool dst reserves). Venues that cannot bound
   * their output — and venue probes that fail — leave the seizure capped by
   * whatever earlier venues produced (or unbounded when none did); simulation
   * stays the final arbiter. Returns undefined when no venue has any output
   * capacity or the sized seizure nets below the configured profit floor.
   */
  private async sizeSeizable(
    encoder: LiquidationEncoder,
    marketParams: IMarketParams,
    seizableCollateral: bigint,
    badDebtPosition: boolean,
  ): Promise<bigint | undefined> {
    const desired = this.decreaseSeizableCollateral(seizableCollateral, badDebtPosition);
    if (desired === 0n) return undefined;

    const collateralToken = getAddress(marketParams.collateralToken);
    const loanToken = getAddress(marketParams.loanToken);

    // Collateral price (oracle-scaled 1e36): converts venue loan-token capacity
    // into a seizure size. Read once — every venue cap uses the same market
    // oracle. When it reverts, caps cannot be computed and the buffered seizure
    // is left untouched (simulation stays the final arbiter).
    let price: bigint | undefined;
    try {
      price = await readContract(this.client, {
        address: marketParams.oracle,
        abi: oraclePriceAbi,
        functionName: "price",
      });
    } catch {
      price = undefined;
    }
    const lif = MarketUtils.getLiquidationIncentiveFactor({ lltv: marketParams.lltv });

    // Venue routing is all-or-nothing per leg (the first supported leg pays the
    // whole implied repayment), so the smallest bounded venue cap is the safe
    // seizure. NEVER discard an already-computed cap when a later venue probe
    // fails or is unbounded — that would route oversized seizures to revert.
    let capped: bigint | undefined;
    for (const venue of this.liquidityVenues) {
      let capacity: bigint | undefined;
      try {
        if (!(await venue.supportsRoute(encoder, collateralToken, loanToken))) continue;
        capacity = await venue.maxOutput?.(encoder, collateralToken, loanToken);
      } catch (error) {
        console.error(`${this.logTag}venue probing failed for ${venue.constructor.name}:`, error);
        continue;
      }
      if (capacity === undefined || price === undefined) continue;

      // Implied repayment grows with seized: repay(S) = S·price/(1e36·LIF).
      // The venue can fund at most `capacity` loan-wei of that repayment, so
      // S_max = capacity·1e36·LIF/price, with a 2% safety haircut on top.
      const sMax = wMulDown((capacity * parseUnits("1", 36) * lif) / price, WAD_98);
      capped = capped === undefined || sMax < capped ? sMax : capped;
    }

    // A bounded venue can pay out nothing right now: nothing can be converted.
    if (capped === 0n) return undefined;

    const seized = capped === undefined ? desired : capped < desired ? capped : desired;

    if (
      this.minProfitUsdFloor !== undefined &&
      this.pricers !== undefined &&
      this.pricers.length > 0
    ) {
      const grossUsd = await this.price(collateralToken, seized, this.pricers);
      if (grossUsd === undefined || grossUsd < this.minProfitUsdFloor) return undefined;
    }

    return seized;
  }

  private async preLiquidate(position: PreLiquidationPosition) {
    const marketParams = position.market.params;
    const seizableCollateral = this.decreaseSeizableCollateral(
      position.seizableCollateral ?? 0n,
      false,
    );

    if (!this.checkCooldown(MarketUtils.getMarketId(marketParams), position.user)) return;

    if (this.isLossLimitReached()) {
      const marketId = MarketUtils.getMarketId(marketParams);
      console.log(
        `${this.logTag}🛑 Skipped ${position.user} on ${marketId} (daily loss limit reached)`,
      );
      this.metrics?.log({
        type: "pre_liquidation",
        outcome: "skipped_loss_limit",
        user: position.user,
        marketId,
      });
      return;
    }

    const { client, executorAddress } = this;

    const encoder = new LiquidationEncoder(executorAddress, client);
    const attemptStart = Date.now();

    if (!(await this.convertCollateralToLoan(marketParams, seizableCollateral, encoder))) return;

    encoder.erc20Approve(marketParams.loanToken, position.preLiquidation, maxUint256);

    encoder.preLiquidate(
      position.preLiquidation,
      position.user,
      seizableCollateral,
      0n,
      encoder.flush(),
    );
    encoder.erc20Skim(marketParams.loanToken, this.treasuryAddress);

    const calls = encoder.flush();

    try {
      const { outcome, profitUsd, gasUsd, txHash } = await this.handleTx(
        encoder,
        calls,
        marketParams,
        false,
      );
      const marketId = MarketUtils.getMarketId(marketParams);
      const latencyMs = Date.now() - attemptStart;
      this.lastAttempt.set(`${position.user}@${marketId}`, { outcome, at: Date.now() });

      if (outcome === "sim_failed") {
        this.simFailureBackoff?.markFailed(marketId, position.user);
      } else if (outcome === "skipped_unprofitable") {
        this.unprofitableBackoff?.markFailed(marketId, position.user);
      }

      if (outcome === "executed" || outcome === "dry_run") {
        this.positionLiquidationCooldownMechanism?.markAttempted(marketId, position.user);
      }

      if (outcome === "executed" && (profitUsd ?? 0) <= 0) {
        this.recordLoss();
      }

      if (outcome === "executed") {
        console.log(`${this.logTag}Pre-liquidated ${position.user} on ${marketId}`);
      } else if (outcome === "dry_run") {
        console.log(
          `${this.logTag}🧪 DRY-RUN valid pre-liquidation found: ${position.user} on ${marketId} (+$${profitUsd?.toFixed(4)}, gas $${gasUsd?.toFixed(6)})`,
        );
      } else if (outcome === "skipped_unprofitable") {
        console.log(`${this.logTag}ℹ️ Skipped ${position.user} on ${marketId} (not profitable)`);
      }

      {
        this.metrics?.log({
          type: "pre_liquidation",
          outcome,
          user: position.user,
          marketId,
          profitUsd,
          gasUsd,
        });
      }

      if (outcome === "executed") {
        void this.notifier?.sendTradeAlert({
          kind: "pre_liquidation",
          outcome: "executed",
          user: position.user,
          marketId,
          profitUsd,
          gasUsd,
          txHash,
          latencyMs,
        });
        if (txHash) void this.confirmReceipt(txHash);
      }
    } catch (error) {
      console.error(
        `${this.logTag}Failed to pre-liquidate ${position.user} on ${MarketUtils.getMarketId(marketParams)}`,
        error,
      );
      this.recordLoss();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const marketId = MarketUtils.getMarketId(marketParams);
      this.lastAttempt.set(`${position.user}@${marketId}`, { outcome: "failed", at: Date.now() });
      this.metrics?.log({
        type: "pre_liquidation",
        outcome: "failed",
        user: position.user,
        marketId,
        error: errorMessage,
      });
      void this.notifier?.sendTradeAlert({
        kind: "pre_liquidation",
        outcome: "failed",
        user: position.user,
        marketId,
        error: errorMessage,
      });
    }
  }

  private async handleTx(
    encoder: LiquidationEncoder,
    calls: Hex[],
    marketParams: IMarketParams,
    badDebtPosition: boolean,
    flashLoanFee = 0n,
  ): Promise<HandleTxResult> {
    const functionData = {
      abi: executorAbi,
      functionName: "exec_606BaXt",
      args: [calls],
    } as const;

    const [{ results }, gasPrice] = await Promise.all([
      simulateCalls(this.client, {
        account: this.client.account.address,
        calls: [
          {
            to: marketParams.loanToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [this.client.account.address],
          },
          { to: encoder.address, ...functionData },
          {
            to: marketParams.loanToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [this.client.account.address],
          },
        ],
      }),
      getGasPrice(this.client),
    ]);

    if (results[1].status !== "success") {
      const reason = shortRevertReason(results[1].error);
      console.warn(`${this.logTag}Transaction failed in simulation: ${reason}`);
      return { outcome: "sim_failed", error: reason };
    }

    const profit = await this.checkProfit(
      marketParams.loanToken,
      {
        beforeTx: results[0].result,
        afterTx: results[2].result,
      },
      {
        used: results[1].gasUsed,
        price: gasPrice,
      },
      badDebtPosition,
      flashLoanFee,
    );

    if (!profit.profitable) return { outcome: "skipped_unprofitable", ...profit };

    // DRY-RUN — full pipeline validated; record the would-be trade instead of broadcasting.
    if (this.dryRun) {
      console.log(
        `${this.logTag}🧪 DRY-RUN would execute on ${marketParams.collateralToken}/${marketParams.loanToken} (+$${profit.profitUsd?.toFixed(4) ?? "?"}, gas $${profit.gasUsd?.toFixed(6) ?? "?"})`,
      );
      return { outcome: "dry_run", ...profit };
    }

    // TX EXECUTION

    if (this.flashbotAccount) {
      const signedBundle = await Flashbots.signBundle([
        {
          transaction: { to: encoder.address, ...functionData },
          client: this.client,
        },
      ]);

      await Flashbots.sendRawBundle(
        signedBundle,
        (await getBlockNumber(this.client)) + 1n,
        this.flashbotAccount,
      );
      // Bundle submissions do not expose a single tx hash — alert without one.
      return { outcome: "executed", ...profit };
    } else {
      const txHash = await writeContract(this.client, {
        address: encoder.address,
        ...functionData,
      });
      return { outcome: "executed", ...profit, txHash };
    }
  }

  private async convertCollateralToLoan(
    marketParams: IMarketParams,
    seizableCollateral: bigint,
    encoder: LiquidationEncoder,
  ) {
    let toConvert = {
      src: getAddress(marketParams.collateralToken),
      dst: getAddress(marketParams.loanToken),
      srcAmount: seizableCollateral,
    };

    let anyRoute = false;
    for (const venue of this.liquidityVenues) {
      try {
        if (await venue.supportsRoute(encoder, toConvert.src, toConvert.dst)) {
          anyRoute = true;
          toConvert = await venue.convert(encoder, toConvert);
        }
      } catch (error) {
        console.error(`${this.logTag}Error converting ${toConvert.src} to ${toConvert.dst}`, error);
        continue;
      }

      if (toConvert.src === toConvert.dst) return true;
    }

    const routeKey = `${toConvert.src}-${toConvert.dst}`;
    if (!anyRoute && !this.noRouteWarned.has(routeKey)) {
      this.noRouteWarned.add(routeKey);
      console.warn(
        `${this.logTag}⚠️ No liquidity venue supports route ${toConvert.src} → ${toConvert.dst}; positions in this market are unmonetizable until a venue is added`,
      );
    }
    return false;
  }

  private async price(asset: Address, amount: bigint, pricers: Pricer[]) {
    let usd = this.priceCache.get(asset);
    if (usd === undefined || Date.now() - usd.at > LiquidationBot.PRICE_CACHE_TTL_MS) {
      let price: number | undefined;
      for (const pricer of pricers) {
        price = await pricer.price(this.client, asset);
        if (price !== undefined) break;
      }
      if (price === undefined) return undefined;
      usd = { price, at: Date.now() };
      this.priceCache.set(asset, usd);
    }

    let decimals = this.decimalsCache.get(asset);
    if (decimals === undefined) {
      decimals =
        asset === this.wNative
          ? 18
          : await readContract(this.client, {
              address: asset,
              abi: erc20Abi,
              functionName: "decimals",
            });
      this.decimalsCache.set(asset, decimals);
    }

    return parseFloat(formatUnits(amount, decimals)) * usd.price;
  }

  private async checkProfit(
    loanAsset: Address,
    loanAssetBalance: {
      beforeTx: bigint | undefined;
      afterTx: bigint | undefined;
    },
    gas: {
      used: bigint;
      price: bigint;
    },
    badDebtPosition: boolean,
    flashLoanFee = 0n,
  ): Promise<{ profitable: boolean; profitUsd?: number; gasUsd?: number }> {
    if (this.alwaysRealizeBadDebt && badDebtPosition) return { profitable: true };
    // No pricers configured = profitability checks disabled for this chain.
    if (this.pricers === undefined || this.pricers.length === 0) return { profitable: true };

    if (loanAssetBalance.beforeTx === undefined || loanAssetBalance.afterTx === undefined)
      return { profitable: false };

    const loanAssetProfit = loanAssetBalance.afterTx - loanAssetBalance.beforeTx - flashLoanFee;

    if (loanAssetProfit <= 0n) return { profitable: false };

    const [loanAssetProfitUsd, gasUsedUsd] = await Promise.all([
      this.price(loanAsset, loanAssetProfit, this.pricers),
      this.price(this.wNative, gas.used * gas.price, this.pricers),
    ]);

    if (loanAssetProfitUsd === undefined || gasUsedUsd === undefined) return { profitable: false };

    const profitUsd = loanAssetProfitUsd - gasUsedUsd;

    return { profitable: profitUsd > 0, profitUsd, gasUsd: gasUsedUsd };
  }

  /**
   * Reloads today's loss counter from the metrics log when the UTC day rolls
   * over. The rollover also triggers yesterday's Telegram daily report (skipped
   * on the constructor call so a restart never re-sends a stale report).
   */
  private refreshDailyLosses() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lossDay === today) return;
    const reportDay = this.lossDay === "" ? undefined : previousUtcDate(today);
    this.lossDay = today;
    this.lossCount = this.metrics?.countTodaysLosses(today) ?? 0;
    if (this.lossCount > 0) {
      console.log(`${this.logTag}🛑 ${this.lossCount} losses already recorded today`);
    }
    if (reportDay !== undefined && this.notifier !== undefined) {
      const stats = aggregateDailyReport(this.metricsPath, reportDay);
      console.log(`${this.logTag}📤 Sending daily report for ${reportDay}`);
      void this.notifier.send(renderDailyReport(stats));
    }
  }

  private isLossLimitReached(): boolean {
    if (!this.maxDailyLosses || this.maxDailyLosses <= 0) return false;
    this.refreshDailyLosses();
    return this.lossCount >= this.maxDailyLosses;
  }

  private recordLoss() {
    this.refreshDailyLosses();
    this.lossCount++;
  }

  private decreaseSeizableCollateral(seizableCollateral: bigint, badDebtPosition: boolean) {
    if (badDebtPosition) return seizableCollateral;

    const liquidationBufferBps =
      chainConfigs[this.chainId]?.options.liquidationBufferBps ?? DEFAULT_LIQUIDATION_BUFFER_BPS;

    return wMulDown(seizableCollateral, WAD - parseUnits(liquidationBufferBps.toString(), 14));
  }

  private checkCooldown(marketId: Hex, account: Address) {
    if (
      this.positionLiquidationCooldownMechanism !== undefined &&
      !this.positionLiquidationCooldownMechanism.isPositionReady(marketId, account)
    ) {
      return false;
    }
    if (
      this.simFailureBackoff !== undefined &&
      !this.simFailureBackoff.isReady(marketId, account)
    ) {
      return false;
    }
    if (
      this.unprofitableBackoff !== undefined &&
      !this.unprofitableBackoff.isReady(marketId, account)
    ) {
      return false;
    }
    return true;
  }

  private async fetchMarkets(readClient?: Client<Transport, Chain>) {
    if (!this.marketsFetchingCooldownMechanism.isFetchingReady()) return;

    let vaultWhitelist: Address[] | "morpho-api" = this.vaultWhitelist;
    if (!this.watchAllBorrowMarkets && vaultWhitelist === "morpho-api")
      vaultWhitelist = await fetchWhitelistedVaults(this.chainId);

    console.log(
      `${this.logTag}${this.watchAllBorrowMarkets ? "📝 Watching all markets with active borrows" : `📝 Watching markets in the following vaults: ${vaultWhitelist}`}`,
    );

    const whitelistedMarketsFromVaults = await this.dataProvider.fetchMarkets(
      (readClient ?? this.client) as Client<Transport, Chain, Account>,
      this.watchAllBorrowMarkets ? [] : (vaultWhitelist as Address[]),
      { watchAllBorrowMarkets: this.watchAllBorrowMarkets },
    );

    this.coveredMarkets = [...whitelistedMarketsFromVaults, ...this.additionalMarketsWhitelist];
  }
}
