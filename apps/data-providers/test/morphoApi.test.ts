import type { Server } from "node:http";

import { Market } from "@morpho-org/blue-sdk";
import type { Address, Chain, Client, Transport } from "viem";
import { encodeAbiParameters, getAddress, keccak256 } from "viem";
import { multicall, readContract } from "viem/actions";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MorphoApiDataProvider } from "../src/morphoApi/index";

vi.mock("viem/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem/actions")>();
  return {
    ...actual,
    multicall: vi.fn(),
    readContract: vi.fn(),
  };
});

vi.mock("@morpho-org/blue-sdk-viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@morpho-org/blue-sdk-viem")>();
  return {
    ...actual,
    fetchMarket: vi.fn(),
  };
});

const CHAIN_ID = 4663;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const ORACLE_PRICE_SCALE = 1_000_000_000_000_000_000_000_000_000_000_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const LLTV = "900000000000000000";

const ORACLE_LIQ = "0x0000000000000000000000000000000000000001";
const ORACLE_NEAR = "0x0000000000000000000000000000000000000002";
const IRM = "0x00000000000000000000000000000000000000a3";
const LOAN = "0x00000000000000000000000000000000000000a1";
const COLLATERAL = "0x00000000000000000000000000000000000000a2";

const USER_LIQ = getAddress("0x00000000000000000000000000000000000000b1");
const USER_NEAR = getAddress("0x00000000000000000000000000000000000000b2");
const MORPHO = "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010"; // 4663 era-2 override

const PRELIQ = "0x00000000000000000000000000000000000000f1";

/**
 * Market ids are keccak256(abi.encode(params)) — the SDK recomputes them from
 * params, so fixtures must derive ids the same way or the API id and the SDK
 * `market.id` diverge (in production both equal the real on-chain id).
 */
function marketIdFromParams(oracle: string): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
      ],
      [getAddress(LOAN), getAddress(COLLATERAL), getAddress(oracle), getAddress(IRM), BigInt(LLTV)],
    ),
  );
}

const MARKET_LIQ = marketIdFromParams(ORACLE_LIQ);
const MARKET_NEAR = marketIdFromParams(ORACLE_NEAR);

function makeMarketRow(id: string, oracle: string) {
  return {
    marketId: id,
    lltv: LLTV,
    irmAddress: IRM,
    oracle: { address: oracle },
    loanAsset: { address: LOAN },
    collateralAsset: { address: COLLATERAL },
    state: {
      supplyAssets: "2000000000000000000000",
      supplyShares: "2000000000000000000000",
      borrowAssets: "950000000000000000000",
      borrowShares: "950000000000000000000",
      fee: "0",
      rateAtTarget: "0",
      timestamp: String(NOW),
    },
    preLiquidations: {
      pageInfo: { countTotal: preLiqContract ? 1 : 0 },
      items: preLiqContract ? [preLiqContract] : [],
    },
  };
}

/** When set, the LIQ market row carries this pre-liquidation contract. */
let preLiqContract: {
  address: string;
  preLltv: string;
  preLCF1: string;
  preLCF2: string;
  preLIF1: string;
  preLIF2: string;
  preLiquidationOracle: string;
} | null = null;

function makePosition(marketId: string, user: string, collateral: string, borrowShares: string) {
  return {
    user: { address: user },
    market: { uniqueKey: marketId },
    state: {
      supplyShares: "1000000000000000000000",
      borrowShares,
      collateral,
    },
  };
}

function makeSdkMarket(id: string, oracle: string): Market {
  return new Market({
    params: {
      loanToken: getAddress(LOAN),
      collateralToken: getAddress(COLLATERAL),
      oracle: getAddress(oracle),
      irm: getAddress(IRM),
      lltv: BigInt(LLTV),
    },
    totalSupplyAssets: 2_000_000_000_000_000_000_000n,
    totalSupplyShares: 2_000_000_000_000_000_000_000n,
    totalBorrowAssets: 950_000_000_000_000_000_000n,
    totalBorrowShares: 950_000_000_000_000_000_000n,
    lastUpdate: BigInt(NOW),
    fee: 0n,
    rateAtTarget: 0n,
    price: ORACLE_PRICE_SCALE,
  });
}

interface GraphQLPayload {
  query?: string;
}

let server: Server | null = null;
let mockUrl = "";
let requests: string[] = [];
/** When set, the mock server replies 500 to every request. */
let failRequests = false;

async function startMockServer(): Promise<number> {
  const { createServer } = await import("node:http");

  return new Promise((resolve) => {
    const http = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += String(chunk)));
      req.on("end", () => {
        const parsed = (JSON.parse(body || "{}") as GraphQLPayload).query ?? "";
        requests.push(parsed);

        if (failRequests) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ errors: [{ message: "mocked outage" }] }));
          return;
        }

        let data: Record<string, unknown> = {};
        if (parsed.includes("getBorrowerPositions")) {
          data = {
            marketPositions: {
              pageInfo: { count: 2, countTotal: 2, limit: 1000, skip: 0 },
              items: [
                makePosition(
                  MARKET_LIQ,
                  USER_LIQ,
                  "1000000000000000000000",
                  "950000000000000000000",
                ),
                makePosition(
                  MARKET_NEAR,
                  USER_NEAR,
                  "1000000000000000000000",
                  "890000000000000000000",
                ),
              ],
            },
          };
        } else if (parsed.includes("getMarketRows")) {
          data = {
            markets: {
              items: [
                makeMarketRow(MARKET_LIQ, ORACLE_LIQ),
                makeMarketRow(MARKET_NEAR, ORACLE_NEAR),
              ],
            },
          };
        } else if (parsed.includes("getBorrowMarkets")) {
          data = {
            markets: {
              items: [
                { marketId: MARKET_LIQ, state: { borrowAssets: "1000" } },
                { marketId: MARKET_NEAR, state: { borrowAssets: "500" } },
                { marketId: "0x9999999999999999999999999999999999999999999999999999999999999999", state: { borrowAssets: "0" } },
              ],
            },
          };
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      });
    });

    http.listen(0, "127.0.0.1", () => {
      const address = http.address();
      if (address && typeof address === "object") {
        server = http;
        mockUrl = `http://127.0.0.1:${address.port}/graphql`;
        resolve(address.port);
      } else {
        resolve(0);
      }
    });
  });
}

function makeClient(): Client<Transport, Chain> {
  return {
    chain: {
      id: CHAIN_ID,
      contracts: { multicall3: { address: MULTICALL3, blockCreated: 0 } },
    } as unknown as Chain,
    account: undefined,
    transport: {} as Transport,
    request: async () => ({ result: "0x0" }),
  } as unknown as Client<Transport, Chain>;
}

describe("MorphoApiDataProvider", () => {
  let provider: MorphoApiDataProvider;
  let client: Client<Transport, Chain>;
  let fetchMarketMock: ReturnType<typeof vi.fn>;
  const multicallMock = vi.mocked(multicall);
  const readContractMock = vi.mocked(readContract);

  beforeAll(async () => {
    await startMockServer();
    provider = new MorphoApiDataProvider({ url: mockUrl });
    client = makeClient();
    fetchMarketMock = vi.mocked((await import("@morpho-org/blue-sdk-viem")).fetchMarket);
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server?.close(() => {
          resolve();
        });
      });
    }
  });

  beforeEach(() => {
    requests = [];
    failRequests = false;
    preLiqContract = null;
    multicallMock.mockReset();
    readContractMock.mockReset();
    fetchMarketMock.mockReset();

    // one oracle price per contract, 1:1 in ORACLE_PRICE_SCALE
    multicallMock.mockResolvedValue(
      [ORACLE_LIQ, ORACLE_NEAR].map((_) => ({
        success: true,
        status: "success",
        result: ORACLE_PRICE_SCALE,
      })),
    );

    fetchMarketMock.mockImplementation(async (marketId) =>
      makeSdkMarket(
        marketId,
        marketId.toLowerCase() === MARKET_LIQ ? ORACLE_LIQ : ORACLE_NEAR,
      ),
    );
  });

  it("fetches all borrow markets when watchAllBorrowMarkets is set", async () => {
    const marketIds = await provider.fetchMarkets(client, [], { watchAllBorrowMarkets: true });
    // Only markets with active borrows are returned, as RAW ids (no prefix)
    expect(marketIds).toContain(MARKET_LIQ);
    expect(marketIds).toContain(MARKET_NEAR);
    expect(marketIds.length).toBe(2);
    expect(requests.some((q) => q.includes("getBorrowMarkets"))).toBe(true);
  });

  it("returns liquidatable and near-liquidatable positions with local risk math", async () => {
    const result = await provider.fetchLiquidatablePositions(client, [MARKET_LIQ, MARKET_NEAR], {
      preLiquidationHealthFactorThreshold: BigInt("1030000000000000000"),
    });

    expect(result.liquidatablePositions.length).toBe(1);
    expect(result.liquidatablePositions[0]?.user).toBe(USER_LIQ);

    expect(result.nearLiquidatablePositions).toBeDefined();
    expect(result.nearLiquidatablePositions!.length).toBe(1);
    expect(result.nearLiquidatablePositions![0]!.user).toBe(USER_NEAR);
  });

  it("does not return near-liquidatable positions without a threshold", async () => {
    const result = await provider.fetchLiquidatablePositions(client, [MARKET_LIQ, MARKET_NEAR]);

    expect(result.liquidatablePositions.length).toBe(1);
    expect(result.nearLiquidatablePositions).toBeUndefined();
  });

  it("reads market state on-chain instead of trusting the API", async () => {
    await provider.fetchLiquidatablePositions(client, [MARKET_LIQ, MARKET_NEAR]);
    expect(fetchMarketMock).toHaveBeenCalledTimes(2);
  });

  it("matches pre-liq authorizations on-chain and batches pre-liq oracle prices", async () => {
    preLiqContract = {
      address: PRELIQ,
      preLltv: "800000000000000000",
      preLCF1: "500000000000000000",
      preLCF2: "800000000000000000",
      preLIF1: "1010000000000000000",
      preLIF2: "1020000000000000000",
      preLiquidationOracle: ORACLE_LIQ,
    };

    // Order-dependent multicall: first the isAuthorized batch (only USER_LIQ
    // authorized), then the pre-liq oracle price batch.
    multicallMock.mockImplementation(async (_client, args) => {
      const contracts = (args as { contracts: { functionName: string; args?: unknown[] }[] })
        .contracts;
      if (contracts[0]?.functionName === "isAuthorized") {
        return contracts.map((contract) => ({
          status: "success" as const,
          result:
            String(contract.args?.[0]).toLowerCase() === USER_LIQ.toLowerCase(),
        }));
      }
      return contracts.map(() => ({
        status: "success" as const,
        result: ORACLE_PRICE_SCALE,
      }));
    });

    const result = await provider.fetchLiquidatablePositions(client, [MARKET_LIQ, MARKET_NEAR]);

    // 1st multicall: on-chain isAuthorized(authorizer, authorizee) per pair
    expect(multicallMock).toHaveBeenCalledTimes(2);
    const authCall = multicallMock.mock.calls[0]![1] as {
      contracts: { functionName: string; address: Address }[];
    };
    expect(authCall.contracts.length).toBe(2); // one pair per position
    expect(authCall.contracts.every((c) => c.functionName === "isAuthorized")).toBe(true);
    expect(authCall.contracts.every((c) => c.address === MORPHO)).toBe(true);

    // 2nd multicall: pre-liq oracle prices (deduplicated)
    const oracleCall = multicallMock.mock.calls[1]![1] as {
      contracts: { address: Address }[];
    };
    const targets = oracleCall.contracts.map((c) => c.address.toLowerCase());
    expect(targets).toContain(ORACLE_LIQ.toLowerCase());
    expect(readContractMock).not.toHaveBeenCalled();

    // No seizable pre-liq expected from these fixtures; wiring is what matters.
    expect(Array.isArray(result.preLiquidatablePositions)).toBe(true);
  });

  it("serves the last candidate set from the hot path when the API fails", async () => {
    // Fresh provider so the cache lifecycle is deterministic in this test.
    const isolated = new MorphoApiDataProvider({ url: mockUrl });

    // 1. Warm the caches with a successful full scan. Market oracles are read
    //    by the SDK's on-chain fetchMarket, so no multicall happens here. The
    //    threshold must match step 2: candidates are cached per last-scan scope.
    const threshold = BigInt("1030000000000000000");
    await isolated.fetchLiquidatablePositions(client, [MARKET_LIQ, MARKET_NEAR], {
      hotPathRpcReads: true,
      fullScanIntervalMs: 60_000,
      preLiquidationHealthFactorThreshold: threshold,
    });
    expect(multicallMock).toHaveBeenCalledTimes(0);

    // 2. Simulate an API outage and force the full-scan interval to expire
    //    (interval 0 ⇒ hot path not warm ⇒ API scan ⇒ fail ⇒ degraded mode).
    failRequests = true;

    // 3. The hot path must serve the candidates via RPC multicall:
    //    market()/rateAtTarget() per market, oracle prices, position() per candidate.
    multicallMock.mockImplementation(async (_client, args) => {
      const contracts = (args as { contracts: { functionName: string; args?: unknown[] }[] })
        .contracts;
      return contracts.map((contract) => {
        if (contract.functionName === "market") {
          return {
            status: "success" as const,
            result: [
              2_000_000_000_000_000_000_000n,
              2_000_000_000_000_000_000_000n,
              950_000_000_000_000_000_000n,
              950_000_000_000_000_000_000n,
              BigInt(NOW),
              0n,
            ],
          };
        }
        if (contract.functionName === "rateAtTarget") {
          return { status: "success" as const, result: 0n };
        }
        if (contract.functionName === "price") {
          return { status: "success" as const, result: ORACLE_PRICE_SCALE };
        }
        if (contract.functionName === "position") {
          const [marketId, user] = contract.args ?? [];
          const isLiq =
            String(marketId).toLowerCase() === MARKET_LIQ &&
            String(user).toLowerCase() === USER_LIQ.toLowerCase();
          const isNear =
            String(marketId).toLowerCase() === MARKET_NEAR &&
            String(user).toLowerCase() === USER_NEAR.toLowerCase();
          if (isLiq) {
            return {
              status: "success" as const,
              result: [1_000_000_000_000_000_000_000n, 950_000_000_000_000_000_000n, 1_000_000_000_000_000_000_000n],
            };
          }
          if (isNear) {
            return {
              status: "success" as const,
              result: [1_000_000_000_000_000_000_000n, 890_000_000_000_000_000_000n, 1_000_000_000_000_000_000_000n],
            };
          }
          return { status: "failure" as const, result: undefined };
        }
        return { status: "failure" as const, result: undefined };
      });
    });

    const result = await isolated.fetchLiquidatablePositions(client, [MARKET_LIQ, MARKET_NEAR], {
      hotPathRpcReads: true,
      fullScanIntervalMs: 0,
      preLiquidationHealthFactorThreshold: threshold,
    });

    // The degraded hot path read state via RPC multicall (market/rate/price/position).
    expect(multicallMock).toHaveBeenCalled();
    expect(result.liquidatablePositions.length).toBe(1);
    expect(result.liquidatablePositions[0]?.user).toBe(USER_LIQ);
    expect(result.nearLiquidatablePositions?.length).toBe(1);
  });
});
