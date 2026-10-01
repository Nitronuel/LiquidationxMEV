import type { AccrualPosition, PreLiquidationPosition } from "@morpho-org/blue-sdk";
import type { Account, Address, Chain, Client, Hex, Transport } from "viem";

export interface LiquidatablePositionsResult {
  liquidatablePositions: AccrualPosition[];
  preLiquidatablePositions: PreLiquidationPosition[];
  /** Positions approaching liquidation (health factor below a configured threshold). */
  nearLiquidatablePositions?: AccrualPosition[];
}

/** Options that tune how a data provider discovers and evaluates opportunities. */
export interface DataProviderScanOptions {
  /** Watch every market with active borrows instead of only vault-whitelisted markets. */
  watchAllBorrowMarkets?: boolean;
  /** Include positions whose health factor (scaled by WAD) is below this value. */
  preLiquidationHealthFactorThreshold?: bigint;
  /**
   * Between full indexer scans, re-read candidate positions directly from the chain
   * via a single multicall (`market()`, `position()`, oracle `price()`, IRM `rateAtTarget()`),
   * bypassing indexer lag on the hot path.
   */
  hotPathRpcReads?: boolean;
  /** How often a full indexer scan runs to rebuild the candidate set (ms). Default: 60000. */
  fullScanIntervalMs?: number;
}

/**
 * Data providers are used to fetch market and position data.
 * All data providers must implement this interface.
 */
export interface DataProvider {
  /**
   * Optional async initialization (e.g. spinning up an indexer, waiting for backfill).
   * Called once before the provider is used.
   */
  init?(): Promise<void>;

  /**
   * Fetch the market IDs for the given vaults. When `watchAllBorrowMarkets` is set,
   * returns every market on the chain with active borrows instead.
   */
  fetchMarkets(
    client: Client<Transport, Chain, Account>,
    vaults: Address[],
    options?: DataProviderScanOptions,
  ): Promise<Hex[]>;

  /**
   * Fetch liquidatable and pre-liquidatable positions for the given market IDs.
   */
  fetchLiquidatablePositions(
    client: Client<Transport, Chain, Account>,
    marketIds: Hex[],
    options?: DataProviderScanOptions,
  ): Promise<LiquidatablePositionsResult>;

  /**
   * Optional: addresses whose on-chain events can change position health factors
   * (e.g. market oracles). Used by the client to subscribe to log triggers.
   */
  fetchWatchAddresses?(client: Client<Transport, Chain, Account>): Promise<Address[]>;
}
