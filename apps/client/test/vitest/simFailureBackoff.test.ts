import { zeroAddress, zeroHash } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SimFailureBackoff } from "../../src/utils/cooldownMechanisms";

describe("SimFailureBackoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks a position immediately after a failure", () => {
    const backoff = new SimFailureBackoff(60_000);
    expect(backoff.isReady(zeroHash, zeroAddress)).toBe(true);

    backoff.markFailed(zeroHash, zeroAddress);

    expect(backoff.isReady(zeroHash, zeroAddress)).toBe(false);
  });

  it("releases the position once the backoff window elapses", () => {
    const backoff = new SimFailureBackoff(60_000);
    backoff.markFailed(zeroHash, zeroAddress);

    vi.advanceTimersByTime(59_999);
    expect(backoff.isReady(zeroHash, zeroAddress)).toBe(false);

    vi.advanceTimersByTime(1);
    expect(backoff.isReady(zeroHash, zeroAddress)).toBe(true);
  });

  it("tracks positions independently", () => {
    const backoff = new SimFailureBackoff(60_000);
    const otherAccount = "0x0000000000000000000000000000000000000002";

    backoff.markFailed(zeroHash, zeroAddress);

    expect(backoff.isReady(zeroHash, otherAccount)).toBe(true);
    expect(backoff.isReady(zeroHash, zeroAddress)).toBe(false);
  });

  it("re-arming extends the window", () => {
    const backoff = new SimFailureBackoff(60_000);
    backoff.markFailed(zeroHash, zeroAddress);
    vi.advanceTimersByTime(30_000);
    backoff.markFailed(zeroHash, zeroAddress);

    vi.advanceTimersByTime(59_999);
    expect(backoff.isReady(zeroHash, zeroAddress)).toBe(false);

    vi.advanceTimersByTime(1);
    expect(backoff.isReady(zeroHash, zeroAddress)).toBe(true);
  });
});
