import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThrottledTrigger } from "../../src/triggers";

describe("ThrottledTrigger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires immediately when idle (leading edge)", () => {
    const onFire = vi.fn();
    const trigger = new ThrottledTrigger(100, onFire);

    trigger.fire();

    expect(onFire).toHaveBeenCalledTimes(1);
    trigger.stop();
  });

  it("collapses a burst into a single trailing fire", () => {
    const onFire = vi.fn();
    const trigger = new ThrottledTrigger(100, onFire);

    trigger.fire(); // leading
    trigger.fire();
    trigger.fire();
    trigger.fire(); // burst — must coalesce

    expect(onFire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(onFire).toHaveBeenCalledTimes(2); // one trailing fire total
    trigger.stop();
  });

  it("respects the minimum interval between fires", () => {
    const onFire = vi.fn();
    const trigger = new ThrottledTrigger(100, onFire);

    trigger.fire(); // t=0 leading fire
    vi.advanceTimersByTime(50);
    trigger.fire(); // schedules trailing at t=100
    vi.advanceTimersByTime(50); // t=100 → trailing fires
    expect(onFire).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30); // t=130 — inside interval
    trigger.fire();
    expect(onFire).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(70); // t=200 → trailing fires
    expect(onFire).toHaveBeenCalledTimes(3);
    trigger.stop();
  });

  it("does not fire after stop", () => {
    const onFire = vi.fn();
    const trigger = new ThrottledTrigger(100, onFire);

    trigger.fire();
    trigger.fire(); // pending trailing
    trigger.stop();
    vi.advanceTimersByTime(500);

    expect(onFire).toHaveBeenCalledTimes(1);
  });
});
