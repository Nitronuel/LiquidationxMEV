import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";

import { buildObservedLiquidation } from "../../src/utils/liquidationObserver";

const SELF = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const RIVAL = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const BORROWER = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
const MARKET = ("0x" + "ab".repeat(32)) as Hex;
const TX = ("0x" + "cd".repeat(32)) as Hex;

const base = {
  marketId: MARKET,
  borrower: BORROWER,
  seizedAssets: 1_000_000n,
  repaidAssets: 4_200_000n,
  txHash: TX,
  blockNumber: 1_234_567n,
  selfAddress: SELF,
  radarEntries: new Set([`${BORROWER}@${MARKET}`]),
};

describe("buildObservedLiquidation", () => {
  it("flags our own executor as self", () => {
    const observation = buildObservedLiquidation({ ...base, caller: SELF });
    expect(observation.self).toBe(true);
  });

  it("flags rival liquidations of radar positions as lost races", () => {
    const observation = buildObservedLiquidation({ ...base, caller: RIVAL });
    expect(observation.self).toBe(false);
    expect(observation.radarSeen).toBe(true);
  });

  it("marks positions never on radar as coverage gaps", () => {
    const observation = buildObservedLiquidation({
      ...base,
      caller: RIVAL,
      borrower: "0xdddddddddddddddddddddddddddddddddddddddd" as Address,
    });
    expect(observation.radarSeen).toBe(false);
  });

  it("matches radar entries case-insensitively on the borrower", () => {
    const observation = buildObservedLiquidation({
      ...base,
      caller: RIVAL,
      borrower: BORROWER.toLowerCase() as Address,
    });
    expect(observation.radarSeen).toBe(true);
  });
});
