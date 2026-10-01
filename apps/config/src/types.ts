import type { Address, Chain, Hex } from "viem";

export type LiquidityVenueName =
  | "1inch"
  | "erc20Wrapper"
  | "erc4626"
  | "lifi"
  | "liquidSwap"
  | "midas"
  | "pendlePT"
  | "uniswapV3"
  | "uniswapV4"
  | "zeroEx";

export type PricerName = "chainlink" | "defillama" | "morphoApi" | "uniswapV3";

export type DataProviderName = "morphoApi";

export interface Config {
  chain: Chain;
  wNative: Address;
  options: Options;
}

export interface Options {
  dataProvider: DataProviderName;
  vaultWhitelist: Address[] | "morpho-api";
  additionalMarketsWhitelist: Hex[];
  liquidityVenues: LiquidityVenueName[];
  pricers?: PricerName[];
  treasuryAddress?: Address;
  liquidationBufferBps?: number;
  useFlashbots: boolean;
  /** Execute liquidations with a Morpho Blue flash loan instead of pre-funded executor capital. */
  useFlashLoans?: boolean;
  blockInterval?: number;
  watchBlocksRetryDelayMs?: number;
  /** Watch every market with active borrows from the indexer, not just the whitelist. */
  watchAllBorrowMarkets?: boolean;
  /** Include near-liquidation positions (health factor below this threshold, scaled by WAD) in results. */
  preLiquidationHealthFactorThresholdBps?: number;
  /**
   * Between full indexer scans, re-read candidate positions directly from the chain
   * via RPC multicall so hot-path state reflects the latest block instead of the indexer head.
   */
  hotPathRpcReads?: boolean;
  /** Interval between full indexer scans that rebuild the candidate set (ms). Default: 60000. */
  fullScanIntervalMs?: number;
  /** Arbitrum Nitro sequencer feed WebSocket URL. Frames arrive before blocks propagate to any RPC and are used as earliest-activity triggers. */
  sequencerFeedUrl?: string;
  /** Interval between safety-net full evaluations of all candidates (ms). Higher values save provider compute units. Default: 30000. */
  hotPathPollMs?: number;
  /** Skip liquidations whose sized seizure nets less than this (USD). Requires pricers. */
  minProfitUsdFloor?: number;
  /** Cooldown (ms) applied to a position after a failed simulation, so transient failures are not re-simulated every cycle. Default: 60000. */
  simFailureBackoffMs?: number;
  /** Cooldown (ms) applied to a position after an unprofitable result, so near-zero-negatives are not retried every cycle. Default: 60000. */
  skippedUnprofitableBackoffMs?: number;
  /** Circuit breaker: stop trading for the UTC day after this many losing executions. */
  maxDailyLosses?: number;
  /** Minimum spacing between evaluations initiated by the same trigger source (ms). Default: 1000. */
  triggerMinIntervalMs?: number;
  /**
   * Secondary HTTP RPC URLs used when the primary fails (strict priority order).
   * Populated automatically from `RPC_URL_<chainId>_FALLBACKS` (comma-separated)
   * plus any extra built-in chain URLs; the primary is never duplicated here.
   */
  fallbackRpcUrls?: string[];
}

export type ChainConfig = Omit<Config, "options"> &
  Options & {
    chainId: number;
    rpcUrl: string;
    /** Optional WebSocket RPC URL. When set, blocks are watched via push subscription (`poll: false`) instead of HTTP polling. */
    wsRpcUrl?: string;
    executorAddress: Address;
    liquidationPrivateKey: Hex;
  };
