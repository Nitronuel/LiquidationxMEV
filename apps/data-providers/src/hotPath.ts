import { AccrualPosition, Market } from "@morpho-org/blue-sdk";
import { getChainAddressesWithOverrides } from "@morpho-blue-liquidation-bot/config";
import { getAddress } from "viem";
import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import { multicall, readContract } from "viem/actions";

import type { DataProviderScanOptions, LiquidatablePositionsResult } from "./dataProvider";

/**
 * Provider-agnostic hot path shared by all data providers (ported verbatim in
 * behavior from HyperIndexDataProvider — see MIGRATION.md Phase 2).
 *
 * Between full scans, candidate positions are re-read directly from the chain
 * via a single batched multicall — Morpho Blue `market()`/`position()` views,
 * IRM `rateAtTarget()`, and oracle `price()`s — then evaluated locally with the
 * same SDK math as the full scan. State reflects the latest block, not the
 * data source's (indexer/API) head.
 */

const MULTICALL_CHUNK_SIZE = 300;

export const DEFAULT_FULL_SCAN_INTERVAL_MS = 60_000;

const oracleAbi = [
  {
    type: "function",
    name: "price",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const morphoBlueViewsAbi = [
  {
    type: "function",
    name: "market",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "totalSupplyAssets", type: "uint128" },
      { name: "totalSupplyShares", type: "uint128" },
      { name: "totalBorrowAssets", type: "uint128" },
      { name: "totalBorrowShares", type: "uint128" },
      { name: "lastUpdate", type: "uint128" },
      { name: "fee", type: "uint128" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "position",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "supplyShares", type: "uint256" },
      { name: "borrowShares", type: "uint256" },
      { name: "collateral", type: "uint256" },
    ],
    stateMutability: "view",
  },
] as const;

const irmViewsAbi = [
  {
    type: "function",
    name: "rateAtTarget",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "", type: "int256" }],
    stateMutability: "view",
  },
] as const;

export interface HotPathMarketRow {
  /** Raw lowercase market id (no chain prefix). */
  id: string;
  /** Raw market id bytes32 (no chain prefix). */
  marketId: string;
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: string;
}

export interface HotPathCandidate {
  user: string;
  /** Raw lowercase market id (no chain prefix). */
  market_id: string;
}

export interface HotPathCaches {
  /** Static market params keyed by raw lowercase market id. */
  marketParams: Map<string, HotPathMarketRow>;
  /** Candidate positions keyed by `${rawLowercaseMarketId}-${user}`. */
  candidates: Map<string, HotPathCandidate>;
  /** Timestamp (Date.now()) of the last full scan that rebuilt the caches. */
  lastFullScanAt: number;
}

/**
 * Batch-read oracle prices on-chain (multicall3, sequential fallback when the
 * chain has no multicall3). Addresses are deduplicated and checksummed.
 */
export async function fetchOraclePrices(
  client: Client<Transport, Chain, Account>,
  oracleAddresses: Iterable<string>,
): Promise<Map<Address, bigint | undefined>> {
  const oracleList = [...new Set([...oracleAddresses].map((o) => getAddress(o)))];
  const oraclePrices = new Map<Address, bigint | undefined>();
  const multicall3Address = client.chain?.contracts?.multicall3?.address;

  if (oracleList.length > 0 && multicall3Address) {
    const results = await multicall(client, {
      multicallAddress: multicall3Address,
      allowFailure: true,
      contracts: oracleList.map((oracle) => ({
        address: oracle,
        abi: oracleAbi,
        functionName: "price",
      })),
    });
    for (let i = 0; i < oracleList.length; i++) {
      const result = results[i];
      const oracle = oracleList[i];
      if (oracle === undefined) continue;
      oraclePrices.set(
        oracle,
        result && result.status === "success" ? result.result : undefined,
      );
    }
  } else if (oracleList.length > 0) {
    for (const oracle of oracleList) {
      try {
        const price = await readContract(client, {
          address: oracle,
          abi: oracleAbi,
          functionName: "price",
        });
        oraclePrices.set(oracle, price);
      } catch {
        oraclePrices.set(oracle, undefined);
      }
    }
  }

  return oraclePrices;
}

/**
 * Owns the candidate-set + market-params caches and runs the RPC-direct scan.
 * A single instance per provider; caches survive failed full scans (degraded
 * mode) so the hot path keeps trading through data-source outages.
 */
export class HotPathScanner {
  readonly caches: HotPathCaches = {
    marketParams: new Map(),
    candidates: new Map(),
    lastFullScanAt: 0,
  };

  get ready(): boolean {
    return this.caches.candidates.size > 0 && this.caches.marketParams.size > 0;
  }

  /** True when the hot path should serve the request (inside the scan interval). */
  isWarm(fullScanIntervalMs: number): boolean {
    return (
      this.ready &&
      Date.now() - this.caches.lastFullScanAt < fullScanIntervalMs
    );
  }

  /**
   * Rebuild caches after a successful full scan. Markets are keyed by raw
   * lowercase market id; candidates by `${marketId}-${user}`.
   */
  refresh(
    markets: HotPathMarketRow[],
    liquidatable: { user: string; market: { id: string } }[],
    nearLiquidatable?: { user: string; market: { id: string } }[],
  ): void {
    this.caches.lastFullScanAt = Date.now();
    this.caches.marketParams.clear();
    for (const m of markets) {
      this.caches.marketParams.set(m.marketId.toLowerCase(), m);
    }
    this.caches.candidates.clear();
    for (const p of [...liquidatable, ...(nearLiquidatable ?? [])]) {
      this.caches.candidates.set(`${p.market.id.toLowerCase()}-${p.user}`, {
        user: p.user,
        market_id: p.market.id.toLowerCase(),
      });
    }
  }

  /**
   * Read current state for the candidate set directly from the chain in one
   * batched multicall and evaluate locally with the SDK math.
   */
  async scan(
    client: Client<Transport, Chain, Account>,
    options?: DataProviderScanOptions,
  ): Promise<LiquidatablePositionsResult> {
    const morphoAddress = getChainAddressesWithOverrides(client.chain.id).morpho;
    const multicallAddress = client.chain?.contracts?.multicall3?.address;
    if (!multicallAddress) throw new Error("multicall3 address unavailable on chain config");

    const candidateList = [...this.caches.candidates.values()];
    const marketRows: HotPathMarketRow[] = [];
    for (const c of candidateList) {
      const row = this.caches.marketParams.get(c.market_id);
      if (row && !marketRows.some((m) => m.marketId === row.marketId)) marketRows.push(row);
    }
    if (marketRows.length === 0) throw new Error("no cached market params for candidates");

    type CallKey =
      | { kind: "market"; id: string }
      | { kind: "rate"; id: string }
      | { kind: "oracle"; oracle: string }
      | { kind: "position"; user: string; market_id: string };

    const contracts: {
      address: Address;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }[] = [];
    const keys: CallKey[] = [];

    for (const m of marketRows) {
      contracts.push({
        address: morphoAddress,
        abi: morphoBlueViewsAbi,
        functionName: "market",
        args: [m.marketId as Hex],
      });
      keys.push({ kind: "market", id: m.marketId.toLowerCase() });
    }
    for (const m of marketRows) {
      contracts.push({
        address: getAddress(m.irm),
        abi: irmViewsAbi,
        functionName: "rateAtTarget",
        args: [m.marketId as Hex],
      });
      keys.push({ kind: "rate", id: m.marketId.toLowerCase() });
    }
    const oracles = [...new Set(marketRows.map((m) => m.oracle.toLowerCase()))];
    for (const oracle of oracles) {
      contracts.push({ address: getAddress(oracle), abi: oracleAbi, functionName: "price" });
      keys.push({ kind: "oracle", oracle });
    }
    for (const c of candidateList) {
      const row = this.caches.marketParams.get(c.market_id);
      if (!row) continue;
      contracts.push({
        address: morphoAddress,
        abi: morphoBlueViewsAbi,
        functionName: "position",
        args: [row.marketId as Hex, getAddress(c.user)],
      });
      keys.push({ kind: "position", user: c.user, market_id: c.market_id });
    }

    const responses: ({ status: "success" | "failure"; result: unknown } | null | undefined)[] = [];
    for (let i = 0; i < contracts.length; i += MULTICALL_CHUNK_SIZE) {
      const chunkResults = await multicall(client, {
        multicallAddress,
        allowFailure: true,
        contracts: contracts.slice(i, i + MULTICALL_CHUNK_SIZE) as never,
      });
      responses.push(
        ...(chunkResults as ({ status: "success" | "failure"; result: unknown } | null)[]),
      );
    }

    const marketState = new Map<
      string,
      { totals: [bigint, bigint, bigint, bigint, bigint, bigint]; rateAtTarget?: bigint }
    >();
    const priceByOracle = new Map<string, bigint>();
    const positionState = new Map<string, [bigint, bigint, bigint]>();

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const res = responses[i];
      if (!key || !res || res.status !== "success") continue;
      if (key.kind === "market") {
        marketState.set(key.id, {
          totals: res.result as [bigint, bigint, bigint, bigint, bigint, bigint],
        });
      } else if (key.kind === "rate") {
        const entry = marketState.get(key.id);
        if (entry) entry.rateAtTarget = res.result as bigint;
      } else if (key.kind === "oracle") {
        priceByOracle.set(key.oracle, res.result as bigint);
      } else if (key.kind === "position") {
        positionState.set(`${key.market_id}-${key.user}`, res.result as [bigint, bigint, bigint]);
      }
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const marketsMap = new Map<string, Market>();
    for (const m of marketRows) {
      const state = marketState.get(m.marketId.toLowerCase());
      if (!state) continue;
      const [
        totalSupplyAssets,
        totalSupplyShares,
        totalBorrowAssets,
        totalBorrowShares,
        lastUpdate,
        fee,
      ] = state.totals;
      try {
        const market = new Market({
          params: {
            loanToken: getAddress(m.loanToken),
            collateralToken: getAddress(m.collateralToken),
            oracle: getAddress(m.oracle),
            irm: getAddress(m.irm),
            lltv: BigInt(m.lltv),
          },
          totalSupplyAssets,
          totalSupplyShares,
          totalBorrowAssets,
          totalBorrowShares,
          lastUpdate,
          fee,
          rateAtTarget: state.rateAtTarget,
          price: priceByOracle.get(m.oracle.toLowerCase()),
        });
        const ts = now > lastUpdate ? now : lastUpdate;
        marketsMap.set(m.marketId.toLowerCase(), market.accrueInterest(ts));
      } catch {
        // Malformed market state — skip; full scan will refresh.
      }
    }

    const threshold = options?.preLiquidationHealthFactorThreshold;
    const liquidatablePositions: AccrualPosition[] = [];
    let nearLiquidatablePositions: AccrualPosition[] | undefined;

    for (const c of candidateList) {
      const market = marketsMap.get(c.market_id);
      if (!market) continue;
      const pos = positionState.get(`${c.market_id}-${c.user}`);
      if (!pos) continue;
      const [supplyShares, borrowShares, collateral] = pos;
      if (borrowShares === 0n) continue;
      try {
        const accrualPosition = new AccrualPosition(
          { user: getAddress(c.user), supplyShares, borrowShares, collateral },
          market,
        );
        const seizable = accrualPosition.seizableCollateral;
        if (seizable !== undefined && seizable > 0n) {
          liquidatablePositions.push(accrualPosition);
        } else if (
          threshold !== undefined &&
          accrualPosition.healthFactor !== undefined &&
          accrualPosition.healthFactor > 0n &&
          accrualPosition.healthFactor < threshold
        ) {
          nearLiquidatablePositions ??= [];
          nearLiquidatablePositions.push(accrualPosition);
        }
      } catch {
        // Malformed position — skip.
      }
    }

    return {
      liquidatablePositions,
      preLiquidatablePositions: [],
      nearLiquidatablePositions,
    };
  }
}
