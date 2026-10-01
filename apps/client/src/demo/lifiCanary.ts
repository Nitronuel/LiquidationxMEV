import { spawn, type ChildProcess } from "node:child_process";

import { chainConfig } from "@morpho-blue-liquidation-bot/config";
import { createLiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import { executorAbi } from "executooor-viem";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  erc4626Abi,
  http,
  parseAbi,
  type Address,
  type Chain,
  type Client,
  type Hex,
  type Transport,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  readContract,
  simulateContract,
  waitForTransactionReceipt,
  writeContract,
} from "viem/actions";

import { LiquidationEncoder } from "../utils/LiquidationEncoder.js";

/**
 * Li.Fi free-tier canary. Two modes:
 *
 *   --quotes  Level 1: quote reliability + route A/B (no chain writes).
 *             Bursts the real Li.Fi venue path keyless, measures latency /
 *             429s / toAmount stability, and compares output against the
 *             direct erc4626 and uniswapV3 routes per market.
 *
 *   --fork    Level 2: atomic executability. Forks Robinhood Chain locally,
 *             funds the executor via impersonated whales, and executes the
 *             Li.Fi quote calldata through `exec_606BaXt` on the fork.
 *             Nothing is broadcast anywhere real.
 *
 * Run: pnpm canary [--quotes | --fork]
 */

const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
const ANVIL_PORT = 8546;
const FORK_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const ANVIL_BIN = `${process.env.HOME}/.foundry/bin/anvil`;

/** Executor owner (hot wallet) — impersonated on the fork, per forkDemo. */
const EXECUTOR_OWNER = "0x4DEB371bD6fb01B3C8a7d656C23f475DDE77276e" as Address;

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const USDE = "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34" as Address;
const SYRUP_USDG = "0x40858070814a57FdF33a613ae84fE0a8b4a874f7" as Address;
const SP_USDG = "0xde770c84FE66E063336b31737cFE9790f18c4087" as Address;

const NOTIONAL = 10_000n;

/** Non-Morpho whales (Blockscout top holders, 2026-08-24), impersonated on the fork. */
const WHALES: Record<string, Address> = {
  [USDE]: "0x24b84023c8e4Da635be228C380C09bfE5271BF9d",
  [SYRUP_USDG]: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  [SP_USDG]: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
};

const UNISWAP_V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa" as Address;
const FEE_TIERS = [500, 3000, 10000];

const PAIRS = [
  { name: "USDe", src: USDE, decimals: 18 },
  { name: "syrupUSDG", src: SYRUP_USDG, decimals: 6 },
  { name: "spUSDG (control)", src: SP_USDG, decimals: 6 },
] as const;

const factoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
]);

interface QuoteStats {
  ok: number;
  fail: number;
  rate429: number;
  latencies: number[];
  toAmounts: bigint[];
  tools: Set<string>;
}

async function fetchQuote(
  fromToken: Address,
  fromAmount: bigint,
  executor: Address,
): Promise<{ status: number; latencyMs: number; body: Record<string, unknown> | undefined }> {
  const url = new URL("https://li.quest/v1/quote");
  const params = {
    fromChain: 4663,
    toChain: 4663,
    fromToken,
    toToken: USDG,
    fromAmount: fromAmount.toString(),
    fromAddress: executor,
    slippage: 0.01,
  };
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });

  const t0 = Date.now();
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const latencyMs = Date.now() - t0;
  let body: Record<string, unknown> | undefined;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON error body
  }
  return { status: res.status, latencyMs, body };
}

function statsSummary(name: string, stats: QuoteStats): string {
  const total = stats.ok + stats.fail;
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1] ?? 0;
  const amounts = stats.toAmounts.map((a) => Number(a) / 1e6);
  const min = amounts.length ? Math.min(...amounts) : 0;
  const max = amounts.length ? Math.max(...amounts) : 0;
  const spread = min > 0 ? `${min.toFixed(2)}–${max.toFixed(2)}` : "—";
  const tools = [...stats.tools].join(",") || "—";
  return (
    `${name}: ${stats.ok}/${total} ok, 429s=${stats.rate429}, ` +
    `latency p50=${p50}ms p95=${p95}ms, toAmount USDG=${spread}, tools=${tools}`
  );
}

async function quotesMode() {
  const config = chainConfig(4663);
  const executor = config.executorAddress;

  // Throwaway key — used ONLY for encoding (venue.convert builds calldata); never funded, never broadcasts.
  const throwaway = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({
    chain: config.chain,
    transport: http(PUBLIC_RPC),
    account: throwaway,
  });
  const publicClient = createPublicClient({
    chain: config.chain,
    transport: http(PUBLIC_RPC),
  }) as Client<Transport, Chain>;

  const erc4626 = createLiquidityVenue("erc4626");
  const uniswapV3 = createLiquidityVenue("uniswapV3");
  const lifi = createLiquidityVenue("lifi");

  console.log("=== Level 1: Li.Fi free-tier quote canary ===\n");

  for (const pair of PAIRS) {
    const amount = NOTIONAL * 10n ** BigInt(pair.decimals);
    const stats: QuoteStats = {
      ok: 0,
      fail: 0,
      rate429: 0,
      latencies: [],
      toAmounts: [],
      tools: new Set(),
    };

    console.log(`--- ${pair.name} → USDG (${NOTIONAL} units) ---`);

    // A/B: direct routes available today (what the bot hits BEFORE Li.Fi in venue order).
    const erc4626Supported = await erc4626.supportsRoute(
      new LiquidationEncoder(executor, wallet),
      pair.src,
      USDG,
    );
    let erc4626Out = "—";
    if (erc4626Supported) {
      const out = await readContract(publicClient, {
        address: pair.src,
        abi: erc4626Abi,
        functionName: "previewRedeem",
        args: [amount],
      });
      erc4626Out = `${Number(out) / 1e6} USDG (exact)`;
    }
    const v3Supported = await uniswapV3.supportsRoute(
      new LiquidationEncoder(executor, wallet),
      pair.src,
      USDG,
    );
    let v3Out = "—";
    if (v3Supported) {
      for (const fee of FEE_TIERS) {
        const pool = await readContract(publicClient, {
          address: UNISWAP_V3_FACTORY,
          abi: factoryAbi,
          functionName: "getPool",
          args: [pair.src, USDG, fee],
        });
        if (pool === "0x0000000000000000000000000000000000000000") continue;
        const [slot0, liquidity] = await Promise.all([
          readContract(publicClient, { address: pool, abi: poolAbi, functionName: "slot0" }),
          readContract(publicClient, { address: pool, abi: poolAbi, functionName: "liquidity" }),
        ]);
        const srcDec = BigInt(pair.decimals);
        const implied =
          (Number(slot0[0]) / 2 ** 96) ** 2 * 10 ** (6 - Number(srcDec)) * Number(amount);
        v3Out = `~${implied.toFixed(2)} USDG (pool ${fee / 100}%, liq ${liquidity})`;
        break;
      }
      if (v3Out === "—") v3Out = "supported, no pool found";
    }

    // Burst of 5 back-to-back (hot-path worst case), then 10 spaced quotes.
    for (let i = 0; i < 15; i++) {
      const { status, latencyMs, body } = await fetchQuote(pair.src, amount, executor);
      if (status === 200 && body && "estimate" in body) {
        stats.ok++;
        stats.latencies.push(latencyMs);
        const estimate = body.estimate as { toAmount?: string };
        const tool = typeof body.tool === "string" ? body.tool : "?";
        stats.tools.add(tool);
        if (estimate.toAmount) stats.toAmounts.push(BigInt(estimate.toAmount));
      } else {
        stats.fail++;
        if (status === 429) stats.rate429++;
        if (i < 5)
          console.log(
            `  quote ${i + 1}: HTTP ${status} after ${latencyMs}ms — ${JSON.stringify(body)?.slice(0, 120)}`,
          );
      }
      // Burst pacing: first 5 back-to-back, then 30s between rounds of 1.
      if (i >= 4 && i < 14) await new Promise((r) => setTimeout(r, 30_000));
    }

    // Path validation: the actual venue class must encode a full swap bundle.
    const encoder = new LiquidationEncoder(executor, wallet);
    try {
      await lifi.convert(encoder, { src: pair.src, dst: USDG, srcAmount: amount });
      const calls = encoder.flush();
      console.log(`  venue.convert() path: OK (${calls.length} calls encoded)`);
    } catch (error) {
      console.log(
        `  venue.convert() path: FAILED — ${error instanceof Error ? error.message.slice(0, 160) : error}`,
      );
    }

    console.log(
      `  A/B direct routes: erc4626=${erc4626Supported ? erc4626Out : "unsupported"} | uniswapV3=${v3Supported ? v3Out : "unsupported"}`,
    );
    console.log(`  ${statsSummary("Li.Fi", stats)}\n`);
  }

  console.log("Pass criteria: ≥95% ok per pair, zero 429s, toAmount spread < 1%.");
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(FORK_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const json = (await res.json()) as { result?: T; error?: unknown };
  if (json.error) throw new Error(`${method} failed: ${JSON.stringify(json.error)}`);
  return json.result as T;
}

async function waitForRpc(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("anvil did not come up in time");
}

function startAnvil(): ChildProcess {
  console.log(`Starting anvil fork of Robinhood Chain from ${PUBLIC_RPC}…`);
  const child = spawn(
    ANVIL_BIN,
    ["--fork-url", PUBLIC_RPC, "--port", String(ANVIL_PORT), "--silent"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr?.on("data", (d: Buffer) => process.stdout.write(`[anvil] ${d}`));
  return child;
}

async function forkMode(filter?: string) {
  const config = chainConfig(4663);
  const executor = config.executorAddress;
  const anvil = startAnvil();
  try {
    await waitForRpc(FORK_RPC);
    console.log("fork ready");
    await rpc("anvil_impersonateAccount", [EXECUTOR_OWNER]);
    await rpc("anvil_setBalance", [EXECUTOR_OWNER, "0x3635C9ADC5DEA00000"]); // 1000 ETH gas

    const wallet = createWalletClient({
      chain: config.chain,
      transport: http(FORK_RPC),
      account: EXECUTOR_OWNER,
    });
    const forkPublic = createPublicClient({
      chain: config.chain,
      transport: http(FORK_RPC),
    }) as Client<Transport, Chain>;

    console.log("\n=== Level 2: Li.Fi fork execution canary ===\n");

    for (const pair of PAIRS) {
      if (filter && !pair.name.toLowerCase().includes(filter.toLowerCase())) continue;
      const amount = NOTIONAL * 10n ** BigInt(pair.decimals);
      console.log(`--- ${pair.name} → USDG (${NOTIONAL} units, atomic via exec_606BaXt) ---`);

      const { status, body } = await fetchQuote(pair.src, amount, executor);
      if (status !== 200 || !body || !("transactionRequest" in body)) {
        console.log(`  SKIP: quote failed (HTTP ${status})`);
        continue;
      }
      const quote = body as unknown as {
        tool: string;
        estimate: { approvalAddress: Address; toAmount: string; toAmountMin: string };
        transactionRequest: { to: Address; value: string; data: Hex };
      };
      console.log(
        `  quote: tool=${quote.tool} toAmount=${Number(quote.estimate.toAmount) / 1e6} toAmountMin=${Number(quote.estimate.toAmountMin) / 1e6}`,
      );

      // Fund the executor from an impersonated whale (fork-local only).
      const whale = WHALES[pair.src];
      await rpc("anvil_impersonateAccount", [whale]);
      await rpc("anvil_setBalance", [whale, "0x3635C9ADC5DEA00000"]); // 1000 ETH gas
      const whaleWallet = createWalletClient({
        chain: config.chain,
        transport: http(FORK_RPC),
        account: whale,
      });
      await writeContract(whaleWallet, {
        address: pair.src,
        abi: erc20Abi,
        functionName: "transfer",
        args: [executor, amount],
        account: whale,
        gas: 200_000n,
      } as never);

      const usdgBefore = await readContract(forkPublic, {
        address: USDG,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [executor],
      });

      // Exact production encoding: approve the quote's spender, push the swap calldata.
      const encoder = new LiquidationEncoder(executor, wallet);
      encoder
        .erc20Approve(pair.src, quote.estimate.approvalAddress, amount)
        .pushCall(
          quote.transactionRequest.to,
          BigInt(quote.transactionRequest.value),
          quote.transactionRequest.data,
        );
      const calls = encoder.flush();

      try {
        // Simulate first so a revert surfaces with its decoded reason.
        const { request } = await simulateContract(wallet, {
          address: executor,
          abi: executorAbi,
          functionName: "exec_606BaXt",
          args: [calls],
          account: EXECUTOR_OWNER,
        } as never);
        const hash = await writeContract(wallet, {
          ...request,
          timeout: 120_000,
        } as never);
        const receipt = await waitForTransactionReceipt(forkPublic as never, { hash });
        const usdgAfter = await readContract(forkPublic, {
          address: USDG,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [executor],
        });
        const received = usdgAfter - usdgBefore;
        const toAmountMin = BigInt(quote.estimate.toAmountMin);
        const ok = received >= toAmountMin;
        console.log(
          `  ${ok ? "✅ EXECUTED" : "❌ SHORTFALL"}: received ${Number(received) / 1e6} USDG ` +
            `(min ${Number(toAmountMin) / 1e6}), gas=${receipt.gasUsed}, status=${receipt.status}`,
        );
      } catch (error) {
        console.log(
          `  ❌ REVERTED: ${error instanceof Error ? error.message.slice(0, 300) : error}`,
        );
      }
    }
  } finally {
    anvil.kill();
  }
}

async function main() {
  const mode = process.argv[2] ?? "--quotes";
  const filter = process.argv[3];
  if (mode === "--quotes") await quotesMode();
  else if (mode === "--fork") await forkMode(filter);
  else {
    console.error(`unknown mode ${mode}; use --quotes or --fork`);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
