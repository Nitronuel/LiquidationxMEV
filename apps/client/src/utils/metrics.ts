import { appendFileSync, existsSync, readFileSync } from "node:fs";

/**
 * Append-only JSONL event log for baseline metrics (Phase 3): radar snapshots,
 * liquidation outcomes, skipped reasons. No-op when no path is configured.
 */
export class MetricsLogger {
  constructor(
    private readonly path: string | undefined,
    private readonly logTag: string,
  ) {}

  log(event: Record<string, unknown>) {
    if (!this.path) return;
    try {
      appendFileSync(this.path, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
    } catch (error) {
      console.error(`${this.logTag}failed to write metrics event:`, error);
    }
  }

  /**
   * Counts today's loss events in the JSONL log (UTC day). A loss is a failed
   * broadcast (gas burned) or an executed trade with non-positive profit.
   * Used by the daily-loss circuit breaker to survive restarts.
   */
  countTodaysLosses(todayUtc: string): number {
    if (!this.path || !existsSync(this.path)) return 0;
    let count = 0;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as {
          ts?: string;
          type?: string;
          outcome?: string;
          profitUsd?: number;
        };
        if (ev.ts?.slice(0, 10) !== todayUtc) continue;
        if (ev.type !== "liquidation" && ev.type !== "pre_liquidation") continue;
        const isLoss =
          ev.outcome === "failed" ||
          (ev.outcome === "executed" && typeof ev.profitUsd === "number" && ev.profitUsd <= 0);
        if (isLoss) count++;
      } catch {
        // skip malformed line
      }
    }
    return count;
  }
}
