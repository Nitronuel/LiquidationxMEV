import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

import {
  chainConfig,
  POSITION_LIQUIDATION_COOLDOWN_ENABLED,
  POSITION_LIQUIDATION_COOLDOWN_PERIOD,
} from "@morpho-blue-liquidation-bot/config";
import { MorphoApiDataProvider } from "@morpho-blue-liquidation-bot/data-providers";
import { createLiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import { createPricer } from "@morpho-blue-liquidation-bot/pricers";
import {
  parseUnits,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  maxUint256,
  parseAbi,
  type Address,
  type Chain,
  type Client,
  type Hex,
  type Transport,
} from "viem";
import { readContract } from "viem/actions";

import { LiquidationBot } from "../bot.js";
import {
  MarketsFetchingCooldownMechanism,
  PositionLiquidationCooldownMechanism,
} from "../utils/cooldownMechanisms.js";
import { LiquidationEncoder } from "../utils/LiquidationEncoder.js";

const FORK_URL = process.env.RPC_URL_4663!;
const ANVIL_PORT = 8545;
const FORK_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const ANVIL_BIN = `${process.env.HOME}/.foundry/bin/anvil`;
const MORPHO = "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010" as Address;
const METRICS_PATH = "/tmp/demo-metrics.jsonl";
/**
 * The executor is owner-gated, so the demo drives it from the REAL owner
 * wallet — impersonated via anvil on the local fork (JSON-RPC signing; no
 * private key involved, nothing leaves this machine).
 */
const EXECUTOR_OWNER = "0x4DEB371bD6fb01B3C8a7d656C23f475DDE77276e";

/** Mid-size borrowers on the spUSDG/USDG market 0x0309c02d…4114 (radar snapshot
 * 2026-08-22). Collateral is an ERC-4626 vault (asset() = USDG), so the bot's
 * primary venue redeems it directly — no DEX depth required. */
const TARGETS = [
  {
    user: "0x39F434F2bEAbA6Df1f200350813C19F5D6d0BeBC",
    marketId: "0x0309c02dabf0be02682af1a2bde9a457f4df0f0b6bc889cde3f948e5315e4114",
  },
  {
    user: "0xC853E78877c758cC43ad152726Cb593f03D23030",
    marketId: "0x0309c02dabf0be02682af1a2bde9a457f4df0f0b6bc889cde3f948e5315e4114",
  },
] as const;

const morphoAbi = parseAbi([
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint256 borrowShares, uint256 collateral)",
  "function market(bytes32 id) view returns (uint256 totalSupplyAssets, uint256 totalSupplyShares, uint256 totalBorrowAssets, uint256 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);
const oracleAbi = parseAbi(["function price() view returns (uint256)"]);
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

async function waitForRpc(url: string, timeoutMs = 30_000): Promise<void> {
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
  console.log("Starting anvil fork of Robinhood…");
  const child = spawn(
    ANVIL_BIN,
    ["--fork-url", FORK_URL, "--port", String(ANVIL_PORT), "--silent"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr?.on("data", (d: Buffer) => process.stdout.write(`[anvil] ${d}`));
  return child;
}

/**
 * Replaces the market oracle's bytecode with a stub returning a price lowered
 * by `bpsDown`, simulating the collateral-price drop that pushes positions
 * underwater. Every position in the market drops proportionally — exactly how
 * real liquidation cascades trigger. The bot's scans read `price()` live from
 * the fork, so detection, sizing, and simulation all see the new price.
 */
async function crashOracle(
  client: Client<Transport, Chain>,
  marketIdHex: Hex,
  bpsDown: bigint,
): Promise<void> {
  const [loanToken, collateralToken, oracle, irm, lltv] = await readContract(client, {
    address: MORPHO,
    abi: morphoAbi,
    functionName: "idToMarketParams",
    args: [marketIdHex],
  });
  void loanToken;
  void collateralToken;
  void irm;
  void lltv;
  const price = await readContract(client, {
    address: oracle,
    abi: oracleAbi,
    functionName: "price",
  });

  const newPrice = (price * (10_000n - bpsDown)) / 10_000n;
  // Minimal contract: PUSH32 <price> MSTORE(0) RETURN(0,32) — answers every call.
  const code = `0x7f${newPrice.toString(16).padStart(64, "0")}60005260206000f3`;
  await rpc("anvil_setCode", [oracle, code]);

  const after = await readContract(client, {
    address: oracle,
    abi: oracleAbi,
    functionName: "price",
  });
  console.log(
    `oracle ${oracle} for market ${marketIdHex}: price ${price} -> ${after} (-${Number(bpsDown)} bps)`,
  );
  if (after !== newPrice) throw new Error("oracle override did not take effect");
}

async function main() {
  const config = chainConfig(4663);
  const account = EXECUTOR_OWNER;
  const anvil = startAnvil();
  try {
    await waitForRpc(FORK_RPC);
    console.log(`fork ready at ${FORK_RPC}`);
    await rpc("anvil_impersonateAccount", [account]);

    const forkPublic = createPublicClient({
      chain: config.chain,
      transport: http(FORK_RPC),
    }) as Client<Transport, Chain>;
    const wallet = createWalletClient({
      chain: config.chain,
      transport: http(FORK_RPC),
      account,
    });
    await rpc("anvil_setBalance", [account, "0x3635C9ADC5DEA00000"]); // 1000 ETH for gas + profit sweep

    console.log("crashing oracle price…");
    await crashOracle(forkPublic, TARGETS[0].marketId as Hex, 50n);

    console.log("probing provider scan against fork state…");
    const provider = new MorphoApiDataProvider();
    const threshold = parseUnits("10300", 14);
    // Regression scope: the target market only. Watching ALL borrow markets
    // fans out ~54 on-chain market fetches through the fork every cycle, which
    // exhausts free upstream RPC rate limits; scan breadth is validated
    // separately by `pnpm validate:4663`.
    const markets = [TARGETS[0].marketId as Hex];
    const scan = await provider.fetchLiquidatablePositions(forkPublic as never, [...markets], {
      preLiquidationHealthFactorThreshold: threshold,
    });
    console.log(
      `probe: liquidatable=${scan.liquidatablePositions.length} preLiq=${scan.preLiquidatablePositions.length} near=${scan.nearLiquidatablePositions?.length ?? "undef"}`,
    );
    for (const p of scan.liquidatablePositions) {
      console.log(`  LIQUIDATABLE ${p.user} hf=${p.healthFactor} seizable=${p.seizableCollateral}`);
    }

    // Verify fork-side state is readable and re-scan to exercise the hot path.
    const [, tBorrowShares, tCollateral] = await readContract(forkPublic as never, {
      address: MORPHO,
      abi: morphoAbi,
      functionName: "position",
      args: [TARGETS[0].marketId as Hex, TARGETS[0].user as Address],
    });
    console.log(
      `fork position ${TARGETS[0].user}: borrowShares=${tBorrowShares} collateral=${tCollateral}`,
    );
    const rescan = await provider.fetchLiquidatablePositions(forkPublic as never, [...markets], {
      preLiquidationHealthFactorThreshold: threshold,
    });
    console.log(
      `hot-path probe: liquidatable=${rescan.liquidatablePositions.length} near=${rescan.nearLiquidatablePositions?.length ?? "undef"}`,
    );
    for (const p of rescan.liquidatablePositions) {
      console.log(
        `  HOT-LIQUIDATABLE ${p.user} hf=${p.healthFactor} seizable=${p.seizableCollateral}`,
      );
    }

    if (existsSync(METRICS_PATH)) rmSync(METRICS_PATH);

    const bot = new LiquidationBot({
      logTag: "[FORK-DEMO]: ",
      chainId: 4663,
      client: wallet,
      wNative: config.wNative,
      vaultWhitelist: [],
      additionalMarketsWhitelist: [TARGETS[0].marketId],
      executorAddress: config.executorAddress,
      treasuryAddress: account,
      dataProvider: provider,
      liquidityVenues: config.liquidityVenues.map(createLiquidityVenue),
      pricers: (config.pricers ?? []).map(createPricer),
      marketsFetchingCooldownMechanism: new MarketsFetchingCooldownMechanism(60_000),
      positionLiquidationCooldownMechanism: POSITION_LIQUIDATION_COOLDOWN_ENABLED
        ? new PositionLiquidationCooldownMechanism(POSITION_LIQUIDATION_COOLDOWN_PERIOD)
        : undefined,
      alwaysRealizeBadDebt: false,
      useFlashLoans: config.useFlashLoans ?? false,
      // Single-market scope (see probe comment): the target enters coveredMarkets
      // via additionalMarketsWhitelist, keeping every cycle within the free RPC's
      // rate budget while still exercising detection, radar, and the hot path.
      watchAllBorrowMarkets: false,
      // Detection must see the fork-side withdrawals: the indexer DB still
      // reports pre-withdrawal collateral, but the hot path re-reads positions
      // directly from the (forked) chain each cycle. Targets enter the
      // candidate set via the first full scan (DB HF ≈ 1.003–1.006 < 1.03
      // radar threshold), then every subsequent cycle evaluates them against
      // live fork state.
      hotPathRpcReads: true,
      fullScanIntervalMs: 600_000,
      metricsPath: METRICS_PATH,
      dryRun: false,
    });

    console.log("running bot cycles against the fork…");
    let executedSeen = false;
    for (let i = 0; i < 12 && !executedSeen; i++) {
      const t0 = Date.now();
      try {
        await bot.run();
        // MorphoApiDataProvider keeps its hot-path state under `scanner.caches`
        // (the old HyperIndex provider exposed candidates/marketParamsCache directly).
        const caches = (
          provider as unknown as {
            scanner?: {
              caches?: { candidates?: Map<string, unknown>; marketParams?: Map<string, unknown> };
            };
          }
        ).scanner?.caches;
        console.log(
          `cycle ${i} (${Date.now() - t0}ms): candidates=${caches?.candidates?.size} paramsCache=${caches?.marketParams?.size}`,
        );
      } catch (err) {
        console.error(`cycle ${i} (${Date.now() - t0}ms) error:`, err);
      }
      if (existsSync(METRICS_PATH)) {
        executedSeen = readFileSync(METRICS_PATH, "utf8").includes('"outcome":"executed"');
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }

    console.log("\n=== DEMO METRICS (realized on fork) ===");
    let botExecuted = false;
    if (existsSync(METRICS_PATH)) {
      for (const line of readFileSync(METRICS_PATH, "utf8").trim().split("\n")) {
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          if (ev.type === "liquidation" || ev.type === "pre_liquidation") {
            console.log(JSON.stringify(ev));
            if (ev.outcome === "executed") botExecuted = true;
          }
        } catch {
          // skip malformed line
        }
      }
    } else {
      console.log("(no liquidation events recorded)");
    }

    if (process.argv.includes("--assert")) {
      if (!botExecuted)
        throw new Error("regression: the bot never recorded an executed liquidation");
      console.log("✅ REGRESSION PASS: bot-driven liquidation executed on fork");
    }

    // Diagnostic + realization: binary-search the largest seizure whose swap
    // output still covers the implied repayment (pool-depth limit), then
    // execute it for real on the fork and measure realized PnL.
    const t = TARGETS[0];
    const [loanToken, collateralToken, oracle, irm, lltv] = await readContract(forkPublic, {
      address: MORPHO,
      abi: morphoAbi,
      functionName: "idToMarketParams",
      args: [t.marketId as Hex],
    });
    const [, , collateral] = await readContract(forkPublic, {
      address: MORPHO,
      abi: morphoAbi,
      functionName: "position",
      args: [t.marketId as Hex, t.user as Address],
    });

    const buildAndSimulate = async (seized: bigint): Promise<boolean> => {
      const encoder = new LiquidationEncoder(config.executorAddress, wallet);
      let routed = false;
      for (const venue of config.liquidityVenues.map(createLiquidityVenue)) {
        if (!(await venue.supportsRoute(encoder, collateralToken, loanToken))) continue;
        await venue.convert(encoder, { src: collateralToken, dst: loanToken, srcAmount: seized });
        routed = true;
        break;
      }
      if (!routed) return false;
      encoder.erc20Approve(loanToken, MORPHO, maxUint256);
      encoder.morphoBlueLiquidate(
        MORPHO,
        { loanToken, collateralToken, oracle, irm, lltv },
        t.user as Address,
        seized,
        0n,
        encoder.flush(),
      );
      encoder.erc20Skim(loanToken, EXECUTOR_OWNER);
      const data = encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "exec_606BaXt",
            stateMutability: "payable",
            inputs: [{ name: "data", type: "bytes[]" }],
            outputs: [],
          },
        ],
        functionName: "exec_606BaXt",
        args: [encoder.flush()],
      });
      return await rpc<{ result?: string }>("eth_call", [
        { from: EXECUTOR_OWNER, to: config.executorAddress, data },
        "latest",
      ])
        .then(() => true)
        .catch(() => false);
    };

    // Seizable boundary ≈ where implied repayment hits total debt (~94% of
    // collateral near HF 1). Search from dust up to 85% of collateral.
    let lo = 10n ** 3n;
    let hi = (collateral * 8_500n) / 10_000n;
    while ((hi - lo) * 100n > collateral) {
      const mid = (lo + hi) / 2n;
      if (await buildAndSimulate(mid)) lo = mid;
      else hi = mid;
    }
    const bestSeized = lo;
    console.log(
      `largest executable seizure: ${bestSeized} of ${collateral} raw (${Number((bestSeized * 100n) / collateral)}%)`,
    );

    // Realize it: measure treasury USDG before, execute, measure after.
    const usdgBefore = await readContract(forkPublic, {
      address: loanToken,
      abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf",
      args: [EXECUTOR_OWNER],
    });
    const encoderFinal = new LiquidationEncoder(config.executorAddress, wallet);
    for (const venue of config.liquidityVenues.map(createLiquidityVenue)) {
      if (await venue.supportsRoute(encoderFinal, collateralToken, loanToken)) {
        console.log(`routing via ${venue.constructor.name}`);
        await venue.convert(encoderFinal, {
          src: collateralToken,
          dst: loanToken,
          srcAmount: bestSeized,
        });
        break;
      }
    }
    encoderFinal.erc20Approve(loanToken, MORPHO, maxUint256);
    encoderFinal.morphoBlueLiquidate(
      MORPHO,
      { loanToken, collateralToken, oracle, irm, lltv },
      t.user as Address,
      bestSeized,
      0n,
      encoderFinal.flush(),
    );
    encoderFinal.erc20Skim(loanToken, EXECUTOR_OWNER);
    const calls = encoderFinal.flush();
    const execData = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "exec_606BaXt",
          stateMutability: "payable",
          inputs: [{ name: "data", type: "bytes[]" }],
          outputs: [],
        },
      ],
      functionName: "exec_606BaXt",
      args: [calls],
    });
    const txHash = await rpc<string>("eth_sendTransaction", [
      { from: EXECUTOR_OWNER, to: config.executorAddress, data: execData, gas: "0x800000" },
    ]);
    await new Promise((r) => setTimeout(r, 1500));
    const receipt = await rpc<{ status: string; gasUsed: string } | null>(
      "eth_getTransactionReceipt",
      [txHash],
    );
    console.log(
      `REAL LIQUIDATION tx ${txHash} status=${receipt?.status} gasUsed=${receipt?.gasUsed}`,
    );
    if (receipt?.status === "0x1") {
      const usdgAfter = await readContract(forkPublic, {
        address: loanToken,
        abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
        functionName: "balanceOf",
        args: [EXECUTOR_OWNER],
      });
      console.log(
        `realized profit (loan token wei skimmed to treasury): ${usdgAfter - usdgBefore}`,
      );
    }
  } finally {
    anvil.kill("SIGKILL");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
