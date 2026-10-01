import { existsSync, readFileSync } from "node:fs";

/**
 * Summarize a bot metrics JSONL log (MetricsLogger output) for soak-test
 * review — see RUNBOOK.md "24h dry-run soak".
 *
 * Usage: pnpm summarize:metrics [path] [--since YYYY-MM-DD]
 * Defaults to METRICS_PATH, then ./metrics.jsonl.
 */

interface RadarPosition {
  user?: string;
  marketId?: string;
  healthFactor?: string;
  collateral?: string;
  borrowAssets?: string;
}

interface TradeEvent {
  ts: string;
  type: "liquidation" | "pre_liquidation";
  outcome: string;
  user?: string;
  marketId?: string;
  profitUsd?: number;
  gasUsd?: number;
}

type MetricsEvent = ({ ts: string; type: string } & Record<string, unknown>) | TradeEvent;

function isTradeEvent(event: MetricsEvent): event is TradeEvent {
  return event.type === "liquidation" || event.type === "pre_liquidation";
}

function parseArgs(argv: string[]): { path: string; since?: string } {
  let path = process.env.METRICS_PATH ?? "./metrics.jsonl";
  let since: string | undefined;
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--since") {
      const value = args[i + 1];
      if (value !== undefined) since = value;
      i++;
    } else if (!arg.startsWith("--")) path = arg;
  }
  return { path, since };
}

function main() {
  const { path, since } = parseArgs(process.argv);
  if (!existsSync(path)) {
    console.error(`metrics file not found: ${path} (set METRICS_PATH or pass a path)`);
    process.exit(1);
  }

  const events: MetricsEvent[] = [];
  let malformed = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as MetricsEvent);
    } catch {
      malformed++;
    }
  }

  const filtered = since ? events.filter((ev) => ev.ts.slice(0, 10) >= since) : events;
  if (filtered.length === 0) {
    console.log(`no events${since ? ` since ${since}` : ""} in ${path} (${events.length} total)`);
    return;
  }

  const firstEvent = filtered[0];
  const lastEvent = filtered[filtered.length - 1];
  if (firstEvent === undefined || lastEvent === undefined) return;
  const first = firstEvent.ts;
  const last = lastEvent.ts;
  const durationHours = (Date.parse(last) - Date.parse(first)) / 3_600_000;

  console.log(`metrics: ${path}${since ? ` (since ${since})` : ""}`);
  console.log(
    `window: ${first} → ${last} (${durationHours.toFixed(1)}h, ${filtered.length} events${
      malformed > 0 ? `, ${malformed} malformed lines skipped` : ""
    })`,
  );

  // ── Radar (near-liquidation snapshots) ────────────────────────────────────
  const radar = filtered.filter(
    (ev): ev is typeof ev & { count: number; positions?: RadarPosition[] } => ev.type === "radar",
  );
  if (radar.length > 0) {
    const counts = radar.map((ev) => ev.count);
    const peak = Math.max(...counts);
    const avg = counts.reduce((sum, count) => sum + count, 0) / counts.length;
    console.log(
      `\nradar: ${radar.length} snapshots, peak ${peak} positions, avg ${avg.toFixed(1)}`,
    );

    const byMarket = new Map<string, { seen: number; minHf: number }>();
    for (const ev of radar) {
      for (const position of ev.positions ?? []) {
        if (!position.marketId) continue;
        const entry = byMarket.get(position.marketId) ?? {
          seen: 0,
          minHf: Number.POSITIVE_INFINITY,
        };
        entry.seen++;
        const hf = Number(position.healthFactor ?? Number.POSITIVE_INFINITY);
        if (Number.isFinite(hf) && hf < entry.minHf) entry.minHf = hf;
        byMarket.set(position.marketId, entry);
      }
    }
    const top = [...byMarket.entries()].sort((a, b) => b[1].seen - a[1].seen).slice(0, 5);
    for (const [marketId, entry] of top) {
      const hf = Number.isFinite(entry.minHf) ? entry.minHf.toFixed(4) : "n/a";
      console.log(`  ${marketId}  seen=${entry.seen}  minHF=${hf}`);
    }
  } else {
    console.log(
      `\nradar: no snapshots recorded (radar empty the whole window, or METRICS_PATH unset for part of it)`,
    );
  }

  // ── Trades (liquidations + pre-liquidations) ──────────────────────────────
  const trades = filtered.filter(isTradeEvent);
  if (trades.length > 0) {
    const byOutcome = new Map<string, number>();
    for (const trade of trades)
      byOutcome.set(trade.outcome, (byOutcome.get(trade.outcome) ?? 0) + 1);
    console.log(`\ntrades: ${trades.length}`);
    for (const [outcome, count] of [...byOutcome.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${outcome}: ${count}`);
    }

    const executed = trades.filter((trade) => trade.outcome === "executed");
    const profit = executed.reduce((sum, trade) => sum + (trade.profitUsd ?? 0), 0);
    const gas = executed.reduce((sum, trade) => sum + (trade.gasUsd ?? 0), 0);
    console.log(
      `executed: ${executed.length} | profit $${profit.toFixed(2)} | gas $${gas.toFixed(2)} | net $${(profit - gas).toFixed(2)}`,
    );

    // Same loss rule as the daily-loss circuit breaker.
    const losses = trades.filter(
      (trade) =>
        trade.outcome === "failed" || (trade.outcome === "executed" && (trade.profitUsd ?? 0) <= 0),
    );
    if (losses.length > 0) {
      console.log(`⚠ loss events: ${losses.length}`);
    }
  } else {
    console.log(`\ntrades: none (expected in DRY_RUN unless the chain drifts liquidatable)`);
  }
}

main();
