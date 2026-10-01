# Data Providers

Data providers are responsible for fetching market and position data for the Morpho Blue Liquidation Bot.

## Interface

Every data provider must implement the `DataProvider` interface (`src/dataProvider.ts`):

- **`init()`** (optional) — Async initialization (e.g. spinning up an indexer, waiting for backfill). Called once before the provider is used.
- **`fetchMarkets(client, vaults, options)`** — Returns the market IDs for the given vaults, or every market on the chain with active borrows when `options.watchAllBorrowMarkets` is set.
- **`fetchLiquidatablePositions(client, marketIds, options)`** — Returns liquidatable, pre-liquidatable, and (optionally) near-liquidatable "radar" positions for the given market IDs.
- **`fetchWatchAddresses(client)`** (optional) — Addresses whose on-chain events can change position health factors (e.g. market oracles), used for log-event triggers.

Data providers are multi-chain: a single instance is shared across all chains. They are created in the script before bots are launched, and each bot receives its provider via dependency injection.

## Available Data Providers

### `morphoApi`

Queries the [Morpho Blue API](https://docs.morpho.org/api) (GraphQL) and reads market state on-chain. No infrastructure required — no indexer, no database.

**How it works:**

- **Positions**: the API supplies *all* borrower positions for the watched markets (no server-side health-factor filter); health factor and seizable collateral are computed **locally** with `@morpho-org/blue-sdk` math. The API is a transport, never the risk engine.
- **Market state**: read on-chain per market via the blue-sdk (aggregated by viem multicall), including live oracle prices — so risk math reflects the exact chain state, not API lag.
- **Pre-liquidations**: contract params come from the API (`Market.preLiquidations`); authorization matching is verified on-chain via Morpho Blue's `isAuthorized` view.
- **Radar**: near-liquidatable positions (health factor below `preLiquidationHealthFactorThreshold`) are computed from the same full borrower set.
- **Hot path** (`hotPathRpcReads`): between full scans, the candidate set is re-read directly from the chain via a single batched multicall (`market()` / `position()` / IRM `rateAtTarget()` / oracle `price()`), bypassing API lag entirely. On API failures, the last candidate cache is kept (degraded mode) so the hot path keeps trading through outages.

### Configuration

Set the data provider in `apps/config/src/config.ts`:

```typescript
[mainnet.id]: {
  options: {
    dataProvider: "morphoApi",
    // ...
  },
},
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RPC_URL_<chainId>` | Yes* | Chain RPC (on-chain market reads, hot path). |
| `RPC_URL_<chainId>_FALLBACKS` | No | Comma-separated backup RPCs (strict-priority fallback transport). |

## Adding a New Data Provider

1. Add the data provider name to the `DataProviderName` type in `apps/config/src/types.ts`.
2. Create a new folder in `src/` with an `index.ts` implementing the `DataProvider` interface. Reuse `src/hotPath.ts` (`HotPathScanner`) for RPC-direct hot reads.
3. Register it in the factory switch in `src/factory.ts`.
4. Export it from `src/index.ts`.
5. Set `options.dataProvider` in the relevant chain configs in `apps/config/src/config.ts`.
6. Add tests in `test/` (mock the API with a local HTTP GraphQL server — see `test/morphoApi.test.ts`).
