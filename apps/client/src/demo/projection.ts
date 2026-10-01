import { chainConfig } from "@morpho-blue-liquidation-bot/config";
import { MorphoApiDataProvider } from "@morpho-blue-liquidation-bot/data-providers";
import { createPricer, type Pricer } from "@morpho-blue-liquidation-bot/pricers";
import { AccrualPosition, MarketUtils, type IMarketParams } from "@morpho-org/blue-sdk";
import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  parseUnits,
  type Account,
  type Address,
  type Chain,
  type Client,
  type Transport,
} from "viem";
import { getGasPrice, readContract } from "viem/actions";

const CHAIN_ID = 4663;
/** Health factor the demo forces positions to before pricing the liquidation. */
const TARGET_HF = 0.995;
/** Flat gas estimate per liquidation (units): exec batch + venue swap. */
const GAS_UNITS = 650_000n;
const K_PRECISION = 10n ** 12n;

interface Row {
  user: Address;
  marketId: string;
  pair: string;
  hfNow: number;
  seizableUsd?: number;
  repaidUsd?: number;
  grossUsd?: number;
  netUsd?: number;
  badDebt: boolean;
}

async function priceWith(
  pricers: Pricer[],
  client: Client<Transport, Chain, Account>,
  asset: Address,
): Promise<number | undefined> {
  for (const pricer of pricers) {
    try {
      const price = await pricer.price(client, asset);
      if (price !== undefined) return price;
    } catch {
      // try next pricer
    }
  }
  return undefined;
}

async function main() {
  const config = chainConfig(CHAIN_ID);
  const client = createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrl),
  }) as Client<Transport, Chain, Account>;
  const pricers = (config.pricers ?? []).map(createPricer);
  const provider = new MorphoApiDataProvider();

  console.log("Fetching markets + positions from the Morpho API…");
  const markets = await provider.fetchMarkets(client as never, [], { watchAllBorrowMarkets: true });
  const thresholdBps = config.preLiquidationHealthFactorThresholdBps ?? 10300;
  const { nearLiquidatablePositions, liquidatablePositions } =
    await provider.fetchLiquidatablePositions(
      client as never,
      [...markets, ...config.additionalMarketsWhitelist],
      { preLiquidationHealthFactorThreshold: parseUnits(thresholdBps.toString(), 14) },
    );

  const candidates = [...liquidatablePositions, ...(nearLiquidatablePositions ?? [])];
  console.log(
    `${candidates.length} candidate positions (${liquidatablePositions.length} already underwater)`,
  );

  const [gasPrice, wNativeUsd] = await Promise.all([
    getGasPrice(client),
    priceWith(pricers, client, config.wNative),
  ]);
  const gasUsd =
    wNativeUsd === undefined
      ? undefined
      : Number(formatUnits(GAS_UNITS * gasPrice, 18)) * wNativeUsd;

  const decimalsCache = new Map<Address, number>();
  const decimals = async (asset: Address): Promise<number> => {
    const cached = decimalsCache.get(asset);
    if (cached !== undefined) return cached;
    const d = await readContract(client, {
      address: asset,
      abi: erc20Abi,
      functionName: "decimals",
    });
    decimalsCache.set(asset, d);
    return d;
  };

  const rows: Row[] = [];
  for (const position of candidates) {
    const params: IMarketParams = position.market.params;
    const marketId = MarketUtils.getMarketId(params);
    const hfNow = position.healthFactor !== undefined ? Number(position.healthFactor) / 1e18 : NaN;
    if (!Number.isFinite(hfNow) || position.borrowShares === 0n) continue;

    let scaled = position;
    if (hfNow > TARGET_HF) {
      // Health factor scales inversely with debt; inflate borrowShares until HF = TARGET_HF.
      const k = hfNow / TARGET_HF;
      const scaledShares =
        (position.borrowShares * BigInt(Math.round(k * Number(K_PRECISION)))) / K_PRECISION;
      scaled = new AccrualPosition(
        {
          user: position.user,
          supplyShares: position.supplyShares,
          borrowShares: scaledShares,
          collateral: position.collateral,
        },
        position.market,
      );
    }

    const seizable = scaled.seizableCollateral;
    if (seizable === undefined || seizable <= 0n) continue;
    const badDebt = seizable >= scaled.collateral;

    const repaidShares = MarketUtils.getLiquidationRepaidShares(seizable, scaled.market, {
      lltv: params.lltv,
    });
    if (repaidShares === undefined) continue;
    const repaidAssets = scaled.market.toBorrowAssets(repaidShares, "Up");

    const [priceCol, priceLoan] = await Promise.all([
      priceWith(pricers, client, params.collateralToken),
      priceWith(pricers, client, params.loanToken),
    ]);
    if (priceCol === undefined || priceLoan === undefined) {
      rows.push({
        user: position.user,
        marketId: short(marketId),
        pair: "?/?",
        hfNow,
        badDebt,
      });
      continue;
    }
    const colDec = await decimals(params.collateralToken);
    const loanDec = await decimals(params.loanToken);

    const seizableUsd = Number(formatUnits(seizable, colDec)) * priceCol;
    const repaidUsd = Number(formatUnits(repaidAssets, loanDec)) * priceLoan;
    const grossUsd = seizableUsd - repaidUsd;

    rows.push({
      user: position.user,
      marketId: short(marketId),
      pair: `${params.collateralToken.slice(0, 6)}…/${params.loanToken.slice(0, 6)}…`,
      hfNow,
      seizableUsd,
      repaidUsd,
      grossUsd,
      netUsd: grossUsd - (gasUsd ?? 0),
      badDebt,
    });
  }

  rows.sort((a, b) => (b.netUsd ?? -Infinity) - (a.netUsd ?? -Infinity));
  console.table(
    rows.map((r) => ({
      user: `${r.user.slice(0, 8)}…${r.user.slice(-4)}`,
      market: r.marketId,
      pair: r.pair,
      HF_now: r.hfNow.toFixed(4),
      seize_usd: r.seizableUsd?.toFixed(2) ?? "?",
      repay_usd: r.repaidUsd?.toFixed(2) ?? "?",
      gross_usd: r.grossUsd?.toFixed(4) ?? "?",
      NET_usd: r.netUsd?.toFixed(4) ?? "?",
      badDebt: r.badDebt ? "YES" : "",
    })),
  );

  const priced = rows.filter((r) => r.netUsd !== undefined);
  const profitable = priced.filter((r) => !r.badDebt && (r.netUsd ?? 0) > 0);
  const totalNet = profitable.reduce((acc, r) => acc + (r.netUsd ?? 0), 0);
  const totalGross = priced.reduce((acc, r) => acc + Math.max(r.grossUsd ?? 0, 0), 0);
  console.log(`\n=== PROJECTION SUMMARY (target HF ${TARGET_HF}) ===`);
  console.log(`candidates priced:       ${priced.length}/${rows.length}`);
  console.log(`profitable (net of gas): ${profitable.length}`);
  console.log(`sum NET if all fire:     $${totalNet.toFixed(2)}`);
  console.log(`sum GROSS (LIF capture): $${totalGross.toFixed(2)}`);
}

function short(id: string) {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
