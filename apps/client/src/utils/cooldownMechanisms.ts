import { Address, Hex } from "viem";

export class PositionLiquidationCooldownMechanism {
  private cooldownPeriod: number;
  private positionReadyAt: Record<Hex, Record<Address, number>>;

  constructor(cooldownPeriod: number) {
    this.cooldownPeriod = cooldownPeriod;
    this.positionReadyAt = {};
  }

  /**
   * Check-only: whether the position can be attempted now. Does NOT consume
   * the position — failed simulations and skips must not burn the retry window.
   */
  isPositionReady(marketId: Hex, account: Address) {
    const readyAt = this.positionReadyAt[marketId]?.[account];
    return readyAt === undefined || readyAt <= Date.now() / 1000;
  }

  /** Records an attempt, starting the cooldown window. Call only on real attempts. */
  markAttempted(marketId: Hex, account: Address) {
    if (this.positionReadyAt[marketId] === undefined) {
      this.positionReadyAt[marketId] = {};
    }
    this.positionReadyAt[marketId][account] = Date.now() / 1000 + this.cooldownPeriod;
  }
}

/**
 * Short cooldown for positions whose simulation failed (e.g. stale aggregator
 * quotes, racing state), so they are not re-simulated on every cycle. Unlike
 * the liquidation cooldown this is intentionally brief — a sim failure can be
 * transient, and a real opportunity must only be delayed, never blocked.
 */
export class SimFailureBackoff {
  private backoffMs: number;
  private readyAt: Record<string, number> = {};

  constructor(backoffMs: number) {
    this.backoffMs = backoffMs;
  }

  isReady(marketId: Hex, account: Address) {
    const readyAt = this.readyAt[`${marketId}-${account}`];
    return readyAt === undefined || readyAt <= Date.now();
  }

  markFailed(marketId: Hex, account: Address) {
    this.readyAt[`${marketId}-${account}`] = Date.now() + this.backoffMs;
  }
}

export class MarketsFetchingCooldownMechanism {
  private cooldownPeriod: number;
  private readyAt: number;

  constructor(cooldownPeriod: number) {
    this.cooldownPeriod = cooldownPeriod;
    this.readyAt = 0;
  }

  isFetchingReady() {
    if (this.readyAt > Date.now() / 1000) {
      return false;
    }
    this.readyAt = Date.now() / 1000 + this.cooldownPeriod;
    return true;
  }
}
