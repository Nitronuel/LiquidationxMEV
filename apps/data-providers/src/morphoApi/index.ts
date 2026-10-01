import { type MarketId, AccrualPosition, Market, PreLiquidationPosition } from "@morpho-org/blue-sdk";
import { getChainAddressesWithOverrides } from "@morpho-blue-liquidation-bot/config";
import "@morpho-org/blue-sdk-viem/lib/augment";
import { fetchMarket, metaMorphoAbi } from "@morpho-org/blue-sdk-viem";
import { BLUE_API_GRAPHQL_URL, Time } from "@morpho-org/morpho-ts";
import { GraphQLClient, type RequestDocument, type Variables } from "graphql-request";
import { getAddress } from "viem";
import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import { multicall, readContract } from "viem/actions";

import type {
  DataProvider,
  DataProviderScanOptions,
  LiquidatablePositionsResult,
} from "../dataProvider";
import {
  DEFAULT_FULL_SCAN_INTERVAL_MS,
  HotPathScanner,
  fetchOraclePrices,
  type HotPathMarketRow,
} from "../hotPath";

import {
  GetBorrowMarketsDocument,
  GetBorrowMarketOraclesDocument,
  GetBorrowerPositionsDocument,
  GetMarketRowsDocument,
} from "./api/queries";
import type {
  ApiBorrowerPosition,
  ApiMarketRow,
  ApiPreLiquidation,
  GetBorrowMarketOraclesResponse,
  GetBorrowMarketsResponse,
  GetBorrowerPositionsResponse,
  GetMarketRowsResponse,
} from "./api/types";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
// On-chain reads get fewer attempts — the hot path re-covers misses every cycle.
const MAX_MARKET_FETCH_ATTEMPTS = 2;

const POSITIONS_PAGE_SIZE = 1000;
const MARKET_ROWS_PAGE_SIZE = 100;
const MARKET_IDS_BATCH_SIZE = 100; // blue-api query complexity batching

const isAuthorizedAbi = [
  {
    type: "function",
    name: "isAuthorized",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "authorizee", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

export interface MorphoApiDataProviderOptions {
  /** Override the blue-api GraphQL endpoint (used by tests). */
  url?: string;
}

/**
 * Data provider backed by the Morpho Blue API (blue-api.morpho.org).
 *
 * Feature parity with the previous HyperIndex provider (MIGRATION.md):
 * - Liquidatable positions: API supplies ALL borrower positions (no
 *   server-side health-factor filter); health factor / seizable collateral are
 *   computed locally with the blue-sdk math — the API is a transport, never
 *   the risk engine.
 * - Near-liquidation radar: same local math against the full borrower set.
 * - Pre-liquidations: contract params from the API (`Market.preLiquidations`),
 *   authorization matching via on-chain `isAuthorized` multicalls.
 * - Hot path: RPC-direct candidate re-reads (shared `HotPathScanner`), state at
 *   the latest block, unaffected by API lag or outages. On API failure during a
 *   full scan the last candidate cache is kept (degraded mode) so the hot path
 *   keeps trading.
 */
export class MorphoApiDataProvider implements DataProvider {
  private readonly client: GraphQLClient;
  private readonly scanner = new HotPathScanner();

  constructor(options?: MorphoApiDataProviderOptions) {
    this.client = new GraphQLClient(options?.url ?? BLUE_API_GRAPHQL_URL);
  }

  private async request<T>(document: RequestDocument, variables?: Variables): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
      try {
        return await this.client.request<T>({ document, variables, signal: controller.signal });
      } catch (error) {
        lastError = error;
        if (attempt < MAX_REQUEST_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** attempt));
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  async fetchMarkets(
    client: Client<Transport, Chain, Account>,
    vaults: Address[],
    options?: DataProviderScanOptions,
  ): Promise<Hex[]> {
    try {
      // Watch every market with active borrows instead of only vault-whitelisted markets
      if (options?.watchAllBorrowMarkets) {
        const marketIds: string[] = [];
        let skip = 0;
        while (true) {
          const response = await this.request<GetBorrowMarketsResponse>(GetBorrowMarketsDocument, {
            chainId: client.chain.id,
            first: MARKET_ROWS_PAGE_SIZE,
            skip,
          });
          for (const item of response.markets.items) {
            if (item.state && BigInt(item.state.borrowAssets) > 0n) marketIds.push(item.marketId);
          }
          if (response.markets.items.length < MARKET_ROWS_PAGE_SIZE) break;
          skip += MARKET_ROWS_PAGE_SIZE;
        }
        console.log(
          `[Chain ${client.chain.id}] Watching ${marketIds.length} markets with active borrows`,
        );
        return [...new Set(marketIds)] as Hex[];
      }

      const vaultMarketIds = await Promise.all(
        vaults.map(async (vault) => this.fetchVaultMarkets(client, vault)),
      );
      return [...new Set(vaultMarketIds.flat())];
    } catch (error) {
      console.error(`[Chain ${client.chain.id}] Error fetching markets for vaults:`, error);
      return [];
    }
  }

  async fetchLiquidatablePositions(
    client: Client<Transport, Chain, Account>,
    marketIds: Hex[],
    options?: DataProviderScanOptions,
  ): Promise<LiquidatablePositionsResult> {
    // Hot path: between full scans, re-read the candidate set directly from the
    // chain via a single multicall. This bypasses API/indexer lag entirely —
    // state is read at the latest block, not at the data source's head.
    const fullScanIntervalMs = options?.fullScanIntervalMs ?? DEFAULT_FULL_SCAN_INTERVAL_MS;
    if (options?.hotPathRpcReads && this.scanner.isWarm(fullScanIntervalMs)) {
      try {
        return await this.scanner.scan(client, options);
      } catch (error) {
        console.error(
          `[Chain ${client.chain.id}] Hot-path RPC read failed, falling back to full scan:`,
          error,
        );
      }
    }

    if (marketIds.length === 0) {
      return { liquidatablePositions: [], preLiquidatablePositions: [] };
    }

    try {
      // 1. Fetch borrower positions (API, all borrowers — no HF filter) in
      //    parallel with pre-liquidation contract params (API) and market
      //    state (on-chain, exact incl. oracle price).
      const [allPositions, marketRows] = await Promise.all([
        this.fetchBorrowerPositions(client.chain.id, marketIds),
        this.fetchMarketRows(client.chain.id, marketIds),
      ]);

      const marketsMap = await this.fetchMarketsOnChain(client, marketIds);

      // 2. Build AccrualPositions and apply local risk filters (SDK math).
      const accrualPositions = allPositions
        .filter((p) => BigInt(p.state?.borrowShares ?? 0) > 0n)
        .map((position) => {
          const market = marketsMap.get(position.market.uniqueKey.toLowerCase());
          if (!market) return;

          return new AccrualPosition(
            {
              user: getAddress(position.user.address),
              // NOTE: BigInt scalars arrive as strings when large and exact
              // numbers when small — BigInt(String(x)) is precise in both cases.
              supplyShares: BigInt(String(position.state?.supplyShares ?? "0")),
              borrowShares: BigInt(String(position.state?.borrowShares ?? "0")),
              collateral: BigInt(String(position.state?.collateral ?? "0")),
            },
            market,
          );
        })
        .filter((position) => position !== undefined);

      const liquidatablePositions = accrualPositions.filter(
        (position) =>
          position.seizableCollateral !== undefined && position.seizableCollateral > 0n,
      );

      // 3. Near-liquidatable positions (radar) when a threshold is configured:
      //    healthy positions with a health factor below the threshold (scaled
      //    by WAD), mirroring the previous provider's semantics.
      let nearLiquidatablePositions: AccrualPosition[] | undefined;
      const preLiquidationHealthFactorThreshold = options?.preLiquidationHealthFactorThreshold;
      if (preLiquidationHealthFactorThreshold !== undefined) {
        nearLiquidatablePositions = accrualPositions.filter(
          (p) =>
            p.seizableCollateral !== undefined &&
            p.seizableCollateral === 0n &&
            p.healthFactor !== undefined &&
            p.healthFactor > 0n &&
            p.healthFactor < preLiquidationHealthFactorThreshold,
        );
      }

      // 4. Pre-liquidatable positions: params from the API, authorization
      //    matching on-chain (`isAuthorized` multicall).
      const preLiquidatablePositions = await this.buildPreLiquidatablePositions(
        client,
        marketRows,
        accrualPositions,
        marketsMap,
      );

      // 5. Refresh hot-path caches (only on success — on API failure the
      //    previous candidate set is kept so the hot path keeps working).
      this.scanner.refresh(
        marketRowsToHotPathRows(marketsMap),
        liquidatablePositions,
        nearLiquidatablePositions,
      );

      return { liquidatablePositions, preLiquidatablePositions, nearLiquidatablePositions };
    } catch (error) {
      console.error(
        `[Chain ${client.chain.id}] Error fetching liquidatable positions from Morpho API:`,
        error,
      );

      // Degraded mode: serve the last known candidates from chain truth so an
      // API outage does not blind the bot between full scans.
      if (this.scanner.ready) {
        try {
          console.warn(
            `[Chain ${client.chain.id}] Morpho API degraded — serving hot-path candidates from last full scan`,
          );
          return await this.scanner.scan(client, options);
        } catch (hotPathError) {
          console.error(`[Chain ${client.chain.id}] Hot-path fallback failed:`, hotPathError);
        }
      }

      return { liquidatablePositions: [], preLiquidatablePositions: [] };
    }
  }

  /**
   * Addresses whose on-chain events can change position health factors: the
   * oracles of every market on this chain with active borrows.
   */
  async fetchWatchAddresses(client: Client<Transport, Chain, Account>): Promise<Address[]> {
    try {
      const oracles = new Set<Address>();
      let skip = 0;
      while (true) {
        const response = await this.request<GetBorrowMarketOraclesResponse>(
          GetBorrowMarketOraclesDocument,
          { chainId: client.chain.id, first: MARKET_ROWS_PAGE_SIZE, skip },
        );
        for (const item of response.markets.items) {
          // Markets with no oracle (rare) come back as a null row — one of them
          // must not discard the whole watch-address set.
          if (item.state && item.oracle !== null && BigInt(item.state.borrowAssets) > 0n) {
            oracles.add(getAddress(item.oracle.address));
          }
        }
        if (response.markets.items.length < MARKET_ROWS_PAGE_SIZE) break;
        skip += MARKET_ROWS_PAGE_SIZE;
      }
      return [...oracles];
    } catch (error) {
      console.error(`[Chain ${client.chain.id}] Error fetching watch addresses:`, error);
      return [];
    }
  }

  /**
   * All borrower positions for the given markets from the API, regardless of
   * health factor (the previous provider trusted the server-side
   * `healthFactor_lte: 1` filter — we now compute HF locally for parity).
   */
  private async fetchBorrowerPositions(
    chainId: number,
    marketIds: Hex[],
  ): Promise<ApiBorrowerPosition[]> {
    const allPositions: ApiBorrowerPosition[] = [];

    // Batch market IDs (API query-complexity limits)
    for (let i = 0; i < marketIds.length; i += MARKET_IDS_BATCH_SIZE) {
      const marketIdsBatch = marketIds.slice(i, i + MARKET_IDS_BATCH_SIZE).map(String);

      let skip = 0;
      while (true) {
        const positionsQuery = await this.request<GetBorrowerPositionsResponse>(
          GetBorrowerPositionsDocument,
          { chainId, marketIds: marketIdsBatch, first: POSITIONS_PAGE_SIZE, skip },
        );

        const items = positionsQuery.marketPositions.items ?? [];
        allPositions.push(...items);

        if (items.length < POSITIONS_PAGE_SIZE) break;
        skip += POSITIONS_PAGE_SIZE;
      }
    }

    return allPositions;
  }

  /** Market rows (used for pre-liquidation params) from the API. */
  private async fetchMarketRows(chainId: number, marketIds: Hex[]): Promise<ApiMarketRow[]> {
    const rows: ApiMarketRow[] = [];

    for (let i = 0; i < marketIds.length; i += MARKET_IDS_BATCH_SIZE) {
      const marketIdsBatch = marketIds.slice(i, i + MARKET_IDS_BATCH_SIZE).map(String);

      let skip = 0;
      while (true) {
        const response = await this.request<GetMarketRowsResponse>(GetMarketRowsDocument, {
          chainId,
          marketIds: marketIdsBatch,
          first: MARKET_ROWS_PAGE_SIZE,
          skip,
        });

        const items = response.markets.items ?? [];
        rows.push(...items);

        if (items.length < MARKET_ROWS_PAGE_SIZE) break;
        skip += MARKET_ROWS_PAGE_SIZE;
      }
    }

    return rows;
  }

  /**
   * Fetch market state on-chain (exact, incl. oracle price) via the blue-sdk,
   * aggregated by viem multicall.
   */
  private async fetchMarketsOnChain(
    client: Client<Transport, Chain, Account>,
    marketIds: Hex[],
  ): Promise<Map<string, Market>> {
    const marketResults = await Promise.allSettled(
      [...marketIds].map(async (marketId) => {
        // Public RPCs occasionally throttle some requests under the parallel
        // fan-out; a short bounded retry recovers most throttled reads. Misses
        // stay tolerated (allSettled) and are re-covered by the next cycle.
        let market: Market | undefined;
        let lastError: unknown;
        for (let attempt = 0; attempt < MAX_MARKET_FETCH_ATTEMPTS; attempt++) {
          try {
            market = await fetchMarket(marketId as MarketId, client, {
              chainId: client.chain.id,
              // Disable `deployless` so that viem multicall aggregates fetches
              deployless: false,
            });
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < MAX_MARKET_FETCH_ATTEMPTS - 1) {
              await new Promise((resolve) =>
                setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** attempt),
              );
            }
          }
        }
        if (market === undefined) throw lastError;

        const now = BigInt(Time.timestamp());
        const timestamp = now > market.lastUpdate ? now : market.lastUpdate;
        return [marketId.toLowerCase(), market.accrueInterest(timestamp)] as const;
      }),
    );

    for (const r of marketResults) {
      if (r.status === "rejected") {
        console.error(`[Chain ${client.chain.id}] Error fetching market:`, r.reason);
      }
    }

    return new Map(
      marketResults
        .filter(
          (r): r is PromiseFulfilledResult<readonly [string, Market]> => r.status === "fulfilled",
        )
        .map((r) => r.value),
    );
  }

  /**
   * Pre-liquidatable positions: a borrowing position is pre-liquidatable by a
   * contract when (a) the contract targets its market, (b) the user authorized
   * the contract on Morpho Blue (on-chain truth), and (c) the pre-liquidation
   * math yields seizable collateral. Best contract wins per (market, user).
   */
  private async buildPreLiquidatablePositions(
    client: Client<Transport, Chain, Account>,
    marketRows: ApiMarketRow[],
    positions: AccrualPosition[],
    marketsMap: Map<string, Market>,
  ): Promise<PreLiquidationPosition[]> {
    // Group pre-liquidation contracts by raw lowercase market id
    const preLiqContractsByMarket = new Map<string, ApiPreLiquidation[]>();
    for (const row of marketRows) {
      const contracts = row.preLiquidations?.items ?? [];
      if (contracts.length > 0) {
        preLiqContractsByMarket.set(row.marketId.toLowerCase(), contracts);
      }
    }
    if (preLiqContractsByMarket.size === 0) return [];

    // Collect (position, contract) candidate pairs for positions on those markets
    const pairs: PreLiqPair[] = [];
    for (const position of positions) {
      const marketId = position.market.id.toLowerCase();
      const contracts = preLiqContractsByMarket.get(marketId);
      if (!contracts) continue;
      for (const contract of contracts) {
        pairs.push({
          user: getAddress(position.user),
          supplyShares: position.supplyShares,
          borrowShares: position.borrowShares,
          collateral: position.collateral,
          contract,
          marketId,
        });
      }
    }
    if (pairs.length === 0) return [];

    // Authorization check: on-chain `isAuthorized(authorizer, authorizee)`
    const morphoAddress = getMorphoAddress(client.chain.id);
    const multicall3Address = client.chain?.contracts?.multicall3?.address;
    const authorized = new Set<string>();

    if (morphoAddress && multicall3Address) {
      const results = await multicall(client, {
        multicallAddress: multicall3Address,
        allowFailure: true,
        contracts: pairs.map((pair) => ({
          address: morphoAddress,
          abi: isAuthorizedAbi,
          functionName: "isAuthorized",
          args: [pair.user, getAddress(pair.contract.address)],
        })),
      });
      for (let i = 0; i < pairs.length; i++) {
        const result = results[i];
        if (result && result.status === "success" && result.result === true) {
          const pair = pairs[i]!;
          authorized.add(`${pair.user}-${getAddress(pair.contract.address)}`);
        }
      }
    } else {
      // Fallback: sequential reads when multicall3 is unavailable on the chain
      for (const pair of pairs) {
        try {
          const isAuthorized = await readContract(client, {
            address: morphoAddress!,
            abi: isAuthorizedAbi,
            functionName: "isAuthorized",
            args: [pair.user, getAddress(pair.contract.address)],
          });
          if (isAuthorized) {
            authorized.add(`${pair.user}-${getAddress(pair.contract.address)}`);
          }
        } catch {
          // Not authorized / read failed — skip.
        }
      }
    }

    // Oracle prices for pre-liquidation oracles (may differ from market oracles)
    const preLiqOracleAddresses = [
      ...new Set(
        pairs.map((pair) => pair.contract.preLiquidationOracle.toLowerCase()),
      ),
    ];
    const oraclePrices = await fetchOraclePrices(client, preLiqOracleAddresses);

    // Build matched pre-liquidation positions
    const preLiqCandidates: PreLiquidationPosition[] = [];
    for (const pair of pairs) {
      const contractAddress = getAddress(pair.contract.address);
      if (!authorized.has(`${pair.user}-${contractAddress}`)) continue;

      const market = marketsMap.get(pair.marketId);
      if (!market) continue;

      const preLiqOracleAddress = getAddress(pair.contract.preLiquidationOracle);
      const preLiqOraclePrice = oraclePrices.get(preLiqOracleAddress);

      const preLiqPosition = new PreLiquidationPosition(
        {
          user: pair.user,
          supplyShares: pair.supplyShares,
          borrowShares: pair.borrowShares,
          collateral: pair.collateral,
          preLiquidation: contractAddress,
          preLiquidationParams: {
            preLltv: BigInt(String(pair.contract.preLltv)),
            preLCF1: BigInt(String(pair.contract.preLCF1)),
            preLCF2: BigInt(String(pair.contract.preLCF2)),
            preLIF1: BigInt(String(pair.contract.preLIF1)),
            preLIF2: BigInt(String(pair.contract.preLIF2)),
            preLiquidationOracle: preLiqOracleAddress,
          },
          preLiquidationOraclePrice: preLiqOraclePrice,
        },
        market,
      );

      if (
        preLiqPosition.seizableCollateral !== undefined &&
        preLiqPosition.seizableCollateral > 0n
      ) {
        preLiqCandidates.push(preLiqPosition);
      }
    }

    // Sort by seizable collateral descending, keep only the best contract per
    // user per market (parity with the previous provider).
    const seizable = (p: PreLiquidationPosition) => p.seizableCollateral ?? 0n;
    preLiqCandidates.sort((a, b) =>
      seizable(a) > seizable(b) ? -1 : seizable(a) < seizable(b) ? 1 : 0,
    );

    const seenUsers = new Set<string>();
    const preLiquidatablePositions: PreLiquidationPosition[] = [];
    for (const position of preLiqCandidates) {
      const key = `${position.market.id}-${position.user}`;
      if (!seenUsers.has(key)) {
        preLiquidatablePositions.push(position);
        seenUsers.add(key);
      }
    }

    return preLiquidatablePositions;
  }

  private async fetchVaultMarkets(
    client: Client<Transport, Chain, Account>,
    vaultAddress: Address,
  ): Promise<Hex[]> {
    try {
      const withdrawQueueLength = await readContract(client, {
        address: vaultAddress,
        abi: metaMorphoAbi,
        functionName: "withdrawQueueLength",
      });

      const indices = Array.from({ length: Number(withdrawQueueLength) }, (_, i) => BigInt(i));

      return await Promise.all(
        indices.map(async (index) => {
          const marketId = await readContract(client, {
            address: vaultAddress,
            abi: metaMorphoAbi,
            functionName: "withdrawQueue",
            args: [index],
          });
          return marketId;
        }),
      );
    } catch (error) {
      console.error(
        `[Chain ${client.chain.id}] Error fetching vault markets for ${vaultAddress}:`,
        error,
      );
      return [];
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** A borrowing position paired with a pre-liquidation contract for its market. */
interface PreLiqPair {
  user: Address;
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
  contract: ApiPreLiquidation;
  marketId: string;
}

function getMorphoAddress(chainId: number): Address | undefined {
  try {
    return getChainAddressesWithOverrides(chainId).morpho;
  } catch {
    return undefined;
  }
}

function marketRowsToHotPathRows(marketsMap: Map<string, Market>): HotPathMarketRow[] {
  const rows: HotPathMarketRow[] = [];
  for (const [marketId, market] of marketsMap) {
    rows.push({
      id: marketId.toLowerCase(),
      marketId,
      loanToken: market.params.loanToken,
      collateralToken: market.params.collateralToken,
      oracle: market.params.oracle,
      irm: market.params.irm,
      lltv: String(market.params.lltv),
    });
  }
  return rows;
}
