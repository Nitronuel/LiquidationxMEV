import {
  FEE_TIERS,
  DEFAULT_FACTORY_ADDRESS,
  specificFactoryAddresses,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
} from "@morpho-blue-liquidation-bot/config";
import { executorAbi, type ExecutorEncoder } from "executooor-viem";
import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  fromHex,
  zeroAddress,
} from "viem";
import { readContract } from "viem/actions";

import { uniswapV3FactoryAbi, uniswapV3PoolAbi } from "../abis/uniswapV3";
import type { LiquidityVenue } from "../liquidityVenue";
import type { ToConvert } from "../types";

export class UniswapV3Venue implements LiquidityVenue {
  private pools: Record<Address, Record<Address, Address[]>> = {};

  async supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address) {
    if (src === dst) return false;

    const pools = this.getCachedPools(src, dst) ?? (await this.fetchPools(encoder, src, dst));

    return pools.length > 0;
  }

  async convert(encoder: ExecutorEncoder, toConvert: ToConvert) {
    const { src, dst, srcAmount } = toConvert;

    const pools = this.getCachedPools(src, dst);

    if (pools === undefined) {
      return toConvert;
    }

    try {
      const liquidities = await Promise.all(
        pools.map(async (pool) => {
          return {
            pool,
            amount: await readContract(encoder.client, {
              address: pool,
              abi: uniswapV3PoolAbi,
              functionName: "liquidity",
            }),
          };
        }),
      );

      const biggestPool = liquidities.reduce(
        (max, liquidity) => (max !== null && liquidity.amount > max.amount ? liquidity : max),
        liquidities[0] ?? null,
      )?.pool;

      if (!biggestPool) {
        throw new Error("(UniswapV3) No Uniswap pool found");
      }

      const zeroForOne = fromHex(src, "bigint") < fromHex(dst, "bigint");

      const encodedContext =
        `0x${0n.toString(16).padStart(24, "0") + zeroAddress.substring(2)}` as const;
      const callbacks = [
        encodeFunctionData({
          abi: executorAbi,
          functionName: "call_g0oyU7o",
          args: [
            src,
            0n,
            encodedContext,
            encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [biggestPool, srcAmount],
            }),
          ],
        }),
      ];

      encoder.pushCall(
        biggestPool,
        0n,
        encodeFunctionData({
          abi: uniswapV3PoolAbi,
          functionName: "swap",
          args: [
            encoder.address,
            zeroForOne,
            srcAmount,
            zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n,
            encodeAbiParameters([{ type: "bytes[]" }, { type: "bytes" }], [callbacks, "0x"]),
          ],
        }),
        {
          sender: biggestPool,
          dataIndex: 2n, // uniswapV3SwapCallback(int256,int256,bytes)
        },
      );

      /// assumed to be the last liquidity venue
      return {
        src: dst,
        dst: dst,
        srcAmount: 0n,
      };
    } catch (error) {
      throw new Error(
        `(UniswapV3) Error swapping: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Hard output cap: the biggest pool's dst-token balance — the actual amount
   * of `dst` the pool can pay out in a single swap right now. Conservative
   * (ignores cross-pool routing and tick-level depth) but never overestimates.
   *
   * NOTE: reads the POOL's balance of the DST token via the dst token contract
   * (`balanceOf(pool)`). Uniswap v3 pools are not ERC20 tokens — calling
   * `balanceOf` on the pool address itself always reverts.
   */
  async maxOutput(
    encoder: ExecutorEncoder,
    src: Address,
    dst: Address,
  ): Promise<bigint | undefined> {
    const pools = this.getCachedPools(src, dst) ?? (await this.fetchPools(encoder, src, dst));
    if (pools.length === 0) return 0n;

    // A failed read means UNKNOWN capacity for that pool, not zero — treat as
    // absent so transient RPC failures degrade to unbounded sizing instead of
    // blinding the bot.
    const balances = await Promise.all(
      pools.map((pool) =>
        readContract(encoder.client, {
          address: dst,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [pool],
        })
          .then((bal): bigint | undefined => bal)
          .catch((): bigint | undefined => undefined),
      ),
    );
    const known = balances.filter((bal): bal is bigint => bal !== undefined);
    if (known.length === 0) return undefined;
    return known.reduce((max, bal) => (bal > max ? bal : max), 0n);
  }

  private getCachedPools(src: Address, dst: Address) {
    if (this.pools[src]?.[dst] !== undefined) return this.pools[src][dst];
    if (this.pools[dst]?.[src] !== undefined) return this.pools[dst][src];
    return undefined;
  }

  private async fetchPools(encoder: ExecutorEncoder, src: Address, dst: Address) {
    const factoryAddress =
      specificFactoryAddresses[encoder.client.chain.id] ?? DEFAULT_FACTORY_ADDRESS;

    try {
      const newPools = (
        await Promise.all(
          FEE_TIERS.map(async (fee) =>
            readContract(encoder.client, {
              address: factoryAddress,
              abi: uniswapV3FactoryAbi,
              functionName: "getPool",
              args: [src, dst, fee],
            }),
          ),
        )
      ).filter((pool) => pool !== zeroAddress);

      if (this.pools[src]?.[dst] === undefined) {
        this.pools[src] = { ...this.pools[src], [dst]: newPools };
      }

      return newPools;
    } catch (error) {
      throw new Error(
        `(UniswapV3) Error fetching pools: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
