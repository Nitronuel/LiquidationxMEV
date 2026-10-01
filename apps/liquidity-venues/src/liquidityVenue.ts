import type { ExecutorEncoder } from "executooor-viem";
import type { Address } from "viem";

import type { ToConvert } from "./types";

/**
 * Liquidity venues are used to convert an amount from a source token to a destination token.
 * All liquidity venues must implement this interface.
 */
export interface LiquidityVenue {
  /**
   * Whether the venue is adapted to the conversion.
   */
  supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address): Promise<boolean> | boolean;

  /**
   * Convert the amount from src to dst.
   */
  convert(executor: ExecutorEncoder, toConvert: ToConvert): Promise<ToConvert> | ToConvert;

  /**
   * Maximum amount of dst token obtainable through this venue right now, in
   * dst-token wei. Used to size liquidations down to what the venue can
   * actually pay out (vault idle balances, pool reserves).
   * Returns undefined when the venue cannot bound its output.
   */
  maxOutput?(encoder: ExecutorEncoder, src: Address, dst: Address): Promise<bigint | undefined>;
}
