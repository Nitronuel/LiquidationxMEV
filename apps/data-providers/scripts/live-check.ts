import { robinhood } from "@morpho-blue-liquidation-bot/config";
import { MorphoApiDataProvider } from "@morpho-blue-liquidation-bot/data-providers";
import {
  createPublicClient,
  getAddress,
  http,
  type Account,
  type Address,
  type Chain,
  type Client,
  type Transport,
} from "viem";
import { multicall, readContract } from "viem/actions";

const CHAIN_ID = 4663;

const rpcUrl = process.env.RPC_URL_4663 ?? robinhood.rpcUrls.default.http[0];
const preLiquidationHealthFactorThresholdBps = Number(
  process.env.PRE_LIQUIDATION_HEALTH_FACTOR_THRESHOLD_BPS ?? 11500,
);

// Read-only client. The data provider only uses `client.chain` and read/multicall
// calls (never the account), so a public client is safe here. The same client
// instance is passed everywhere (cast to the provider's Account-typed signature);
// it MUST carry a real transport or every on-chain read fails and this check
// passes vacuously.
const client = createPublicClient({
  chain: robinhood,
  transport: http(rpcUrl, { batch: false }),
});
const providerClient = client as unknown as Client<Transport, Chain, Account>;

const oracleAbi = [
  {
    type: "function",
    name: "price",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

async function main() {
  const provider = new MorphoApiDataProvider();

  const marketIds = await provider.fetchMarkets(providerClient, [], {
    watchAllBorrowMarkets: true,
  });
  console.log(`[LiveCheck] markets with active borrows: ${marketIds.length}`);
  if (marketIds.length === 0) throw new Error("[LiveCheck] no borrow markets found");

  const threshold = BigInt(preLiquidationHealthFactorThresholdBps) * 10n ** 14n;
  const { liquidatablePositions, nearLiquidatablePositions } =
    await provider.fetchLiquidatablePositions(providerClient, marketIds, {
      preLiquidationHealthFactorThreshold: threshold,
    });

  console.log(`[LiveCheck] liquidatable positions: ${liquidatablePositions.length}`);
  for (const p of liquidatablePositions.slice(0, 10)) {
    console.log(
      `  liq  ${p.user} market ${p.market.params.id.slice(0, 10)}… seizable ${p.seizableCollateral}`,
    );
  }

  console.log(
    `[LiveCheck] near-liquidatable positions (HF < ${threshold}): ${nearLiquidatablePositions?.length ?? 0}`,
  );
  for (const p of (nearLiquidatablePositions ?? []).slice(0, 10)) {
    console.log(`  near ${p.user} market ${p.market.params.id.slice(0, 10)}… HF ${p.healthFactor}`);
  }

  await verifyOraclePrices();
  console.log("[LiveCheck] OK");
}

/**
 * Sanity check: the multicall3 batch must return the same oracle price as a
 * direct readContract for the same oracles.
 */
async function verifyOraclePrices() {
  const provider = new MorphoApiDataProvider();
  const oracles = (await provider.fetchWatchAddresses(providerClient)).slice(0, 2);
  console.log(`[LiveCheck] verifying oracle prices for ${oracles.length} oracles via multicall3`);

  const results = (await multicall(providerClient, {
    allowFailure: true,
    contracts: oracles.map((oracle) => ({
      address: oracle,
      abi: oracleAbi,
      functionName: "price",
    })),
  } as unknown as Parameters<typeof multicall>[1])) as unknown as {
    status: "success" | "failure";
    result?: bigint;
  }[];

  for (let i = 0; i < oracles.length; i++) {
    const oracle = oracles[i];
    if (!oracle) continue;
    const batch = results[i]?.status === "success" ? results[i]?.result : undefined;

    let direct: bigint | undefined;
    try {
      direct = (await readContract(providerClient, {
        address: oracle,
        abi: oracleAbi,
        functionName: "price",
      } as unknown as Parameters<typeof readContract>[1])) as bigint;
    } catch {
      direct = undefined;
    }

    // The check is whether the multicall3 batch matches a direct readContract
    // for the same oracle. Both may legitimately revert (undefined) if the
    // oracle reverts on price() at the current block.
    const match = batch === direct;
    console.log(
      `  oracle ${oracle}: batch=${batch ?? "revert"} direct=${direct ?? "revert"} ${match ? "MATCH" : "MISMATCH"}`,
    );
    if (!match) {
      throw new Error(`[LiveCheck] oracle price mismatch for ${oracle}`);
    }
  }
}

void main()
  .then(() => {
    console.log(`[LiveCheck] done (chain ${CHAIN_ID}, rpc ${rpcUrl})`);
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(`[LiveCheck] FAILED:`, error);
    process.exit(1);
  });
