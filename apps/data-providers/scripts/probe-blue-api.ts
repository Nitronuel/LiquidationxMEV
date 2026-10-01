/**
 * Phase 1 probe for MIGRATION.md — verifies what blue-api.morpho.org supports
 * before the HyperIndex → MorphoApi provider migration.
 *
 * Self-contained (plain fetch, no workspace imports) so it runs without a build:
 *   pnpm tsx apps/data-providers/scripts/probe-blue-api.ts
 *
 * Answers:
 *  1. Does the schema expose pre-liquidation / authorization entities?
 *  2. Does marketPositions return ALL borrowers (no healthFactor filter) + pagination limits?
 *  3. Which dynamic Market.state fields exist (lastUpdate / fee / rateAtTarget)?
 *  4. Live 4663 position counts (reconciliation vs indexer snapshot).
 */

const API_URL = "https://blue-api.morpho.org/graphql";
const CHAIN_ID = 4663;

// Sample of the 4663 additionalMarketsWhitelist (from apps/config/src/config.ts)
const SAMPLE_MARKET_IDS = [
  "0x0309c02dabf0be02682af1a2bde9a457f4df0f0b6bc889cde3f948e5315e4114", // spUSDG/USDG whale market
  "0xc845da65a020ddca5f132efa8fea79676d8edfdea504226a4c01e7a9e34cddd6", // WETH/USDG
  "0xf4dff250826a86627545e5c6594b3b249db3ad2ec5eed56c02833d2a67acf445", // TSLA/USDG
];

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (res.status === 429) throw new Error("HTTP 429 (rate limited)");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join(" | "));
    if (!json.data) throw new Error("empty response data");
    return json.data;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Probe 1: schema introspection ────────────────────────────────────────────

interface IntrospectionType {
  name: string;
  kind: string;
  fields: { name: string }[] | null;
}

const INTROSPECTION = `
  query Introspect {
    __schema {
      types {
        name
        kind
        fields { name }
      }
    }
  }
`;

async function probeSchema(): Promise<void> {
  console.log("=== Probe 1: schema introspection ===");
  const data = await gql<{ __schema: { types: IntrospectionType[] } }>(INTROSPECTION);
  const types = data.__schema.types.filter(
    (t) => !t.name.startsWith("__") && t.kind === "OBJECT",
  );

  const interesting = (name: string) =>
    /preliq|pre.?liquidat|authoriz/i.test(name);

  const matches = types.filter((t) => interesting(t.name));
  console.log(
    `Pre-liq / authorization-related OBJECT types: ${matches.length === 0 ? "NONE FOUND" : ""}`,
  );
  for (const t of matches) {
    console.log(`  ${t.name}: ${(t.fields ?? []).map((f) => f.name).join(", ")}`);
  }

  // Print fields of the core position/market types we plan to query
  for (const wanted of ["MarketPosition", "MarketPositionState", "Market", "MarketState"]) {
    const t = types.find((x) => x.name === wanted);
    if (!t) {
      console.log(`  [missing type] ${wanted}`);
      continue;
    }
    console.log(`  ${t.name}: ${(t.fields ?? []).map((f) => f.name).join(", ")}`);
  }
}

// ── Probe 2: all borrower positions on 4663 (no healthFactor filter) ────────

const ALL_BORROWERS = `
  query AllBorrowers($chainId: Int!, $first: Int, $skip: Int, $marketIds: [String!]) {
    marketPositions(
      first: $first
      skip: $skip
      where: { chainId_in: [$chainId], marketUniqueKey_in: $marketIds, borrowShares_gte: 0 }
      orderBy: BorrowShares
      orderDirection: Desc
    ) {
      pageInfo { count countTotal limit skip }
      items {
        user { address }
        market { uniqueKey: marketId }
        state { supplyShares borrowShares collateral }
      }
    }
  }
`;

interface MarketPositionPage {
  marketPositions: {
    pageInfo: { count: number; countTotal: number; limit: number; skip: number } | null;
    items: {
      user: { address: string };
      market: { uniqueKey: string };
      state: { supplyShares: string; borrowShares: string; collateral: string } | null;
    }[] | null;
  };
}

async function probeBorrowers(marketIds: string[], first: number): Promise<void> {
  console.log(`=== Probe: marketPositions (first=${first}, markets=${marketIds.length}) ===`);
  try {
    const page = await gql<MarketPositionPage>(ALL_BORROWERS, {
      chainId: CHAIN_ID,
      first,
      skip: 0,
      marketIds,
    });
    const p = page.marketPositions.pageInfo;
    const items = page.marketPositions.items ?? [];
    console.log(
      `  OK: returned ${items.length}, pageInfo=${JSON.stringify(p)} ` +
        `(borrowers>0: ${items.filter((i) => i.state && BigInt(i.state.borrowShares) > 0n).length})`,
    );
  } catch (err) {
    console.log(`  FAILED: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Probe 3: dynamic market state fields on 4663 ────────────────────────────

const MARKET_STATE = `
  query MarketState($chainId: Int!, $marketIds: [String!]) {
    markets(
      first: 100
      where: { chainId_in: [$chainId], uniqueKey_in: $marketIds }
    ) {
      items {
        marketId
        lltv
        oracle { address }
        irmAddress
        loanAsset { address decimals }
        collateralAsset { address decimals }
        state {
          borrowAssets
          supplyAssets
          collateralAssets
          lastUpdate
          fee
          rateAtTarget
        }
      }
    }
  }
`;

async function probeMarketState(): Promise<void> {
  console.log("=== Probe: Market.state dynamic fields (lastUpdate/fee/rateAtTarget) ===");
  try {
    const data = await gql<{
      markets: {
        items: {
          marketId: string;
          state: Record<string, unknown> | null;
        }[];
      };
    }>(MARKET_STATE, { chainId: CHAIN_ID, marketIds: SAMPLE_MARKET_IDS });
    for (const m of data.markets.items) {
      console.log(`  ${m.marketId.slice(0, 10)}…: ${JSON.stringify(m.state)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  FAILED (missing fields show up here): ${msg}`);
  }
}

// ── Probe 4: 4663 full-chain borrower reconciliation ─────────────────────────

const CHAIN_BORROW_MARKETS = `
  query ChainBorrowMarkets($chainId: Int!, $first: Int, $skip: Int) {
    markets(
      first: $first
      skip: $skip
      where: { chainId_in: [$chainId] }
      orderBy: BorrowAssets
      orderDirection: Desc
    ) {
      pageInfo { count countTotal limit skip }
      items {
        marketId
        state { borrowAssets }
      }
    }
  }
`;

async function probeChainReconciliation(): Promise<void> {
  console.log("=== Probe: 4663 reconciliation (borrow markets + position counts) ===");
  try {
    const markets: { marketId: string; state: { borrowAssets: string } | null }[] = [];
    let skip = 0;
    while (true) {
      const page = await gql<{
        markets: {
          pageInfo: { countTotal: number } | null;
          items: { marketId: string; state: { borrowAssets: string } | null }[];
        };
      }>(CHAIN_BORROW_MARKETS, { chainId: CHAIN_ID, first: 100, skip });
      markets.push(...page.markets.items);
      if (page.markets.items.length < 100) break;
      skip += 100;
    }
    const withBorrows = markets.filter(
      (m) => m.state && BigInt(m.state.borrowAssets) > 0n,
    );
    console.log(
      `  markets total=${markets.length}, with active borrows=${withBorrows.length} ` +
        `(indexer snapshot: ~70 markets, ~273 borrow positions)`,
    );

    // Count borrowers across the borrow-active markets (paged)
    let borrowers = 0;
    const ids = withBorrows.map((m) => m.marketId);
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      let positionSkip = 0;
      while (true) {
        const page = await gql<MarketPositionPage>(ALL_BORROWERS, {
          chainId: CHAIN_ID,
          first: 100,
          skip: positionSkip,
          marketIds: batch,
        });
        const items = page.marketPositions.items ?? [];
        borrowers += items.filter((it) => it.state && BigInt(it.state.borrowShares) > 0n).length;
        if (items.length < 100) break;
        positionSkip += 100;
      }
    }
    console.log(`  borrow positions across borrow-active markets: ${borrowers}`);
  } catch (err) {
    console.log(`  FAILED: ${err instanceof Error ? err.message : err}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await probeSchema();
  await probeMarketState();
  await probeBorrowers(SAMPLE_MARKET_IDS, 100);
  await probeBorrowers(SAMPLE_MARKET_IDS, 1000); // page-size limit probe
  await probeChainReconciliation();
  console.log("\nProbe complete — record findings in MIGRATION.md Phase 1.");
}

main().catch((err) => {
  console.error("[Probe] fatal:", err);
  process.exitCode = 1;
});
