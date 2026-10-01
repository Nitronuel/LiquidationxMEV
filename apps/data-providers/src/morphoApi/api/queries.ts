import { gql } from "graphql-tag";

/**
 * Additional blue-api queries for MorphoApiDataProvider v2 (MIGRATION.md Phase 2).
 * Verified against the live schema on 2026-09-13 (see MIGRATION.md Phase 1).
 *
 * Notes:
 * - BigInt scalars arrive as strings when they exceed the JSON safe range and
 *   as (exact) numbers otherwise — always convert with `BigInt(String(x))`.
 * - `marketPositions` has no server-side health-factor filter requirement; we
 *   deliberately fetch ALL borrowers and compute HF locally with the SDK so the
 *   risk semantics match the previous HyperIndex provider exactly.
 */

/** All borrower positions for a set of markets, regardless of health factor. */
export const GetBorrowerPositionsDocument = gql`
  query getBorrowerPositions(
    $chainId: Int!
    $marketIds: [String!]
    $first: Int!
    $skip: Int!
  ) {
    marketPositions(
      where: { chainId_in: [$chainId], marketUniqueKey_in: $marketIds, borrowShares_gte: 0 }
      first: $first
      skip: $skip
      orderBy: BorrowShares
      orderDirection: Desc
    ) {
      pageInfo {
        count
        countTotal
        limit
        skip
      }
      items {
        user {
          address
        }
        market {
          uniqueKey: marketId
        }
        state {
          supplyShares
          borrowShares
          collateral
        }
      }
    }
  }
`;

/**
 * Market rows (params + dynamic state) for a set of markets, with
 * pre-liquidation contracts inlined (paginated connection).
 */
export const GetMarketRowsDocument = gql`
  query getMarketRows($chainId: Int!, $marketIds: [String!], $first: Int!, $skip: Int!) {
    markets(
      where: { chainId_in: [$chainId], uniqueKey_in: $marketIds }
      first: $first
      skip: $skip
    ) {
      items {
        marketId
        lltv
        irmAddress
        oracle {
          address
        }
        loanAsset {
          address
        }
        collateralAsset {
          address
        }
        state {
          supplyAssets
          supplyShares
          borrowAssets
          borrowShares
          fee
          rateAtTarget
          timestamp
        }
        preLiquidations(first: 100) {
          pageInfo {
            countTotal
          }
          items {
            address
            preLltv
            preLCF1
            preLCF2
            preLIF1
            preLIF2
            preLiquidationOracle
          }
        }
      }
    }
  }
`;

/**
 * Chain-wide borrow-market discovery (used with `watchAllBorrowMarkets`).
 * Ordered by borrow assets descending so consumers can stop at the first
 * market without active borrows.
 */
export const GetBorrowMarketsDocument = gql`
  query getBorrowMarkets($chainId: Int!, $first: Int!, $skip: Int!) {
    markets(
      where: { chainId_in: [$chainId] }
      first: $first
      skip: $skip
      orderBy: BorrowAssets
      orderDirection: Desc
    ) {
      items {
        marketId
        state {
          borrowAssets
        }
      }
    }
  }
`;

/** Oracle addresses of every market on a chain with active borrows (log triggers). */
export const GetBorrowMarketOraclesDocument = gql`
  query getBorrowMarketOracles($chainId: Int!, $first: Int!, $skip: Int!) {
    markets(
      where: { chainId_in: [$chainId] }
      first: $first
      skip: $skip
      orderBy: BorrowAssets
      orderDirection: Desc
    ) {
      items {
        oracle {
          address
        }
        state {
          borrowAssets
        }
      }
    }
  }
`;
