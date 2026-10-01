/**
 * Types for the new blue-api queries (MIGRATION.md Phase 2).
 *
 * BigInt scalars arrive as strings once they exceed the JSON safe integer
 * range and as exact numbers below it — every field is typed `string | number`
 * (aliased `BigIntScalar`) and converted with `BigInt(String(x))`, which is
 * precise in both cases. Never type them as plain `number`.
 */

/** Blue-api BigInt scalar: string when large, exact number when small. */
export type BigIntScalar = string | number;

/** Pre-liquidation contract params as exposed by `Market.preLiquidations`. */
export interface ApiPreLiquidation {
  address: string;
  preLltv: BigIntScalar;
  preLCF1: BigIntScalar;
  preLCF2: BigIntScalar;
  preLIF1: BigIntScalar;
  preLIF2: BigIntScalar;
  preLiquidationOracle: string;
}

/** Market row (params + dynamic state) as exposed by the `markets` query. */
export interface ApiMarketRow {
  marketId: string;
  lltv: BigIntScalar;
  irmAddress: string;
  oracle: { address: string };
  loanAsset: { address: string };
  collateralAsset: { address: string };
  state: {
    supplyAssets: BigIntScalar;
    supplyShares: BigIntScalar;
    borrowAssets: BigIntScalar;
    borrowShares: BigIntScalar;
    fee: BigIntScalar;
    rateAtTarget: BigIntScalar;
    timestamp: BigIntScalar;
  } | null;
  preLiquidations: {
    pageInfo: { countTotal: number };
    items: ApiPreLiquidation[];
  };
}

/** Borrower position as exposed by the `marketPositions` query. */
export interface ApiBorrowerPosition {
  user: { address: string };
  market: { uniqueKey: string };
  state: {
    supplyShares: BigIntScalar;
    borrowShares: BigIntScalar;
    collateral: BigIntScalar;
  } | null;
}

export interface GetBorrowerPositionsResponse {
  marketPositions: {
    pageInfo: { count: number; countTotal: number; limit: number; skip: number } | null;
    items: ApiBorrowerPosition[];
  };
}

export interface GetMarketRowsResponse {
  markets: { items: ApiMarketRow[] };
}

export interface GetBorrowMarketsResponse {
  markets: {
    items: { marketId: string; state: { borrowAssets: BigIntScalar } | null }[];
  };
}

export interface GetBorrowMarketOraclesResponse {
  markets: {
    items: {
      oracle: { address: string };
      state: { borrowAssets: BigIntScalar } | null;
    }[];
  };
}

// ── Legacy types (codegen'd sdk.ts, removed in MIGRATION.md Phase 5) ────────

import * as Types from "@morpho-org/blue-api-sdk";

export type GetLiquidatablePositionsQueryVariables = Types.Exact<{
  chainId: Types.Scalars["Int"]["input"];
  marketIds?: Types.InputMaybe<
    Types.Scalars["String"]["input"][] | Types.Scalars["String"]["input"]
  >;
  skip?: Types.InputMaybe<Types.Scalars["Int"]["input"]>;
  first?: Types.InputMaybe<Types.Scalars["Int"]["input"]>;
  orderBy?: Types.InputMaybe<Types.MarketPositionOrderBy>;
  orderDirection?: Types.InputMaybe<Types.OrderDirection>;
}>;

export interface GetLiquidatablePositionsQuery {
  __typename?: "Query";
  marketPositions: {
    __typename?: "PaginatedMarketPositions";
    pageInfo: {
      __typename?: "PageInfo";
      count: number;
      countTotal: number;
      limit: number;
      skip: number;
    } | null;
    items:
      | {
          __typename?: "MarketPosition";
          healthFactor: number | null;
          user: { __typename?: "User"; address: Types.Scalars["Address"]["output"] };
          market: {
            __typename?: "Market";
            uniqueKey: Types.Scalars["MarketId"]["output"];
            oracle: { __typename?: "Oracle"; address: Types.Scalars["Address"]["output"] } | null;
          };
          state: {
            __typename?: "MarketPositionState";
            borrowShares: Types.Scalars["BigInt"]["output"];
            collateral: Types.Scalars["BigInt"]["output"];
            supplyShares: Types.Scalars["BigInt"]["output"];
          } | null;
        }[]
      | null;
  };
}
