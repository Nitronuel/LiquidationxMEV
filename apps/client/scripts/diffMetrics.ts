import { existsSync, readFileSync } from "node:fs";

/**
 * Diff a soak-test metrics JSONL log against the pre-migration baseline for the
 * Phase 4 go/no-go gate — see MIGRATION.md §3 Phase 4 and RUNBOOK.md.
 *
 * Both files are MetricsLogger JSONL output (`radar`, `liquidation`,
 * `pre_liquidation`, `liquidation_observed` events). Radar counts are compared
 * as order-of-magnitude ratios (chain drift between capture windows makes exact
 * equality meaningless); trade/observation events are compared as raw counts.
 *
 * Usage:
 *   pnpm diff:metrics <baseline.jsonl> <soak.jsonl> [--max-ratio N] [--since YYYY-MM-DD]
 *
 * Exit codes: 0 = pass (go), 1 = fail (no-go), 2 = usage/IO error.
 */

interface RadarPosition {
  user?: string;
  marketId?: string;
  healthFactor?: string;
}

interface MetricsEvent {
  ts: string;
  type: string;
  outcome?: string;
  count?: number;
  profitUsd?: number;
  radarSeen?: boolean;
  self?: boolean;
  positions?: RadarPosition[];
  user?: string;
  marketId?: string;
}

interface WindowStats {
  path: string;
  first: string;
  last: string;
  hours: number;
  events: number;
  malformed: number;
  radarSnapshots: number;
  radarPeak: number;
  radarAvg: number;
  /** Distinct `user@marketId` radar entries across the whole window. */
  radarUnique: number;
  liquidations: number;
  executed: number;
  failed: number;
  preLiquidations: number;
  /** Competitor liquidations on positions that were on our radar (race losses). */
  observedTotal: number;
  observedLost: number;
}

interface Check {
  label: string;
  pass: boolean;
  detail: string;
}

const DEFAULT_MAX_RATIO = 10;

function parseArgs(argv: string[]): {
  baselinePath: string | undefined;
  soakPath: string | undefined;
  maxRatio: number;
  since?: string;
} {
  const args = argv.slice(2);
  let maxRatio = DEFAULT_MAX_RATIO;
  let since: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--max-ratio") {
      const value = args[i + 1];
      if (value !== undefined) maxRatio = Number(value);
      i++;
    } else if (arg === "--since") {
      const value = args[i + 1];
      if (value !== undefined) since = value;
      i++;
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }

  return {
    baselinePath: positional[0],
    soakPath: positional[1],
    maxRatio: Number.isFinite(maxRatio) && maxRatio > 0 ? maxRatio : DEFAULT_MAX_RATIO,
    since,
  };
}

function loadWindow(path: string, since?: string): WindowStats {
  if (!existsSync(path)) {
    console.error(`metrics file not found: ${path}`);
    process.exit(2);
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
    console.error(`no events${since ? ` since ${since}` : ""} in ${path} (${events.length} total)`);
    process.exit(2);
  }

  const firstEvent = filtered[0];
  const lastEvent = filtered[filtered.length - 1];
  if (firstEvent === undefined || lastEvent === undefined) {
    console.error(`empty metrics file: ${path}`);
    process.exit(2);
  }

  const radar = filtered.filter((ev) => ev.type === "radar");
  const counts = radar.map((ev) => ev.count ?? 0);
  const unique = new Set<string>();
  for (const ev of radar) {
    for (const position of ev.positions ?? []) {
      if (position.user && position.marketId) unique.add(`${position.user}@${position.marketId}`);
    }
  }

  const liquidations = filtered.filter((ev) => ev.type === "liquidation");
  const preLiquidations = filtered.filter((ev) => ev.type === "pre_liquidation");
  const observed = filtered.filter((ev) => ev.type === "liquidation_observed");

  return {
    path,
    first: firstEvent.ts,
    last: lastEvent.ts,
    hours: (Date.parse(lastEvent.ts) - Date.parse(firstEvent.ts)) / 3_600_000,
    events: filtered.length,
    malformed,
    radarSnapshots: radar.length,
    radarPeak: counts.length > 0 ? Math.max(...counts) : 0,
    radarAvg: counts.length > 0 ? counts.reduce((sum, count) => sum + count, 0) / counts.length : 0,
    radarUnique: unique.size,
    liquidations: liquidations.length,
    executed: liquidations.filter((ev) => ev.outcome === "executed").length,
    failed: liquidations.filter(
      (ev) => ev.outcome === "failed" || (ev.outcome === "executed" && (ev.profitUsd ?? 0) <= 0),
    ).length,
    preLiquidations: preLiquidations.length,
    observedTotal: observed.length,
    observedLost: observed.filter((ev) => ev.radarSeen === true && ev.self === false).length,
  };
}

function printWindow(label: string, stats: WindowStats): void {
  console.log(
    `\n${label}: ${stats.path}\n` +
      `  window: ${stats.first} → ${stats.last} (${stats.hours.toFixed(1)}h, ${stats.events} events` +
      `${stats.malformed > 0 ? `, ${stats.malformed} malformed skipped` : ""})\n` +
      `  radar: ${stats.radarSnapshots} snapshots, peak ${stats.radarPeak}, avg ${stats.radarAvg.toFixed(1)}, ${stats.radarUnique} distinct positions\n` +
      `  liquidation events: ${stats.liquidations} (executed ${stats.executed}, loss events ${stats.failed})\n` +
      `  pre-liquidation events: ${stats.preLiquidations}\n` +
      `  observed (competitor + self): ${stats.observedTotal} (radar race losses: ${stats.observedLost})`,
  );
}

/** Order-of-magnitude ratio: how many times larger the smaller side is of the larger. */
function magnitudeRatio(a: number, b: number): number {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  if (high === 0) return 1; // both empty — identical
  if (low === 0) return Number.POSITIVE_INFINITY; // one empty, one not
  return high / low;
}

function ratioLabel(ratio: number): string {
  return Number.isFinite(ratio) ? `${ratio.toFixed(1)}x` : "∞";
}

function buildChecks(baseline: WindowStats, soak: WindowStats, maxRatio: number): Check[] {
  const checks: Check[] = [];

  // 1. Radar coverage: soak peak within maxRatio of baseline peak.
  const radarRatio = magnitudeRatio(baseline.radarPeak, soak.radarPeak);
  checks.push({
    label: "radar peak within ratio",
    pass: radarRatio <= maxRatio,
    detail:
      `baseline peak ${baseline.radarPeak} vs soak peak ${soak.radarPeak} ` +
      `(${ratioLabel(radarRatio)}, gate ≤ ${maxRatio}x)`,
  });

  // 2. No competitor liquidations on positions that were on our radar —
  //    the soak must not introduce race losses the baseline didn't have.
  checks.push({
    label: "no new radar race losses",
    pass: soak.observedLost === 0,
    detail:
      soak.observedLost === 0
        ? "no competitor liquidations on radar-watched positions"
        : `${soak.observedLost} competitor liquidation(s) on radar-watched positions — coverage gap`,
  });

  // 3. No failed executions. In DRY_RUN the pipeline simulates but never
  //    broadcasts, so any `failed` outcome signals a sizing/routing defect.
  checks.push({
    label: "no failed executions",
    pass: soak.failed === 0,
    detail: `${soak.failed} loss event(s) in soak window`,
  });

  // 4. Radar actually recorded snapshots (a silent radar means discovery broke).
  checks.push({
    label: "radar snapshots recorded",
    pass: soak.radarSnapshots > 0,
    detail: `${soak.radarSnapshots} snapshot(s) in soak window`,
  });

  return checks;
}

function main() {
  const { baselinePath, soakPath, maxRatio, since } = parseArgs(process.argv);
  if (!baselinePath || !soakPath) {
    console.error(
      "usage: pnpm diff:metrics <baseline.jsonl> <soak.jsonl> [--max-ratio N] [--since YYYY-MM-DD]",
    );
    process.exit(2);
  }

  const baseline = loadWindow(baselinePath, since);
  const soak = loadWindow(soakPath, since);
  printWindow("baseline", baseline);
  printWindow("soak", soak);

  console.log(`\ngates (max-ratio ${maxRatio}x):`);
  let passed = 0;
  for (const check of buildChecks(baseline, soak, maxRatio)) {
    console.log(`  ${check.pass ? "✅" : "❌"} ${check.label}: ${check.detail}`);
    if (check.pass) passed++;
  }

  const go = passed === buildChecks(baseline, soak, maxRatio).length;
  console.log(`\n${go ? "✅ GO" : "❌ NO-GO"}: ${passed} checks passed`);
  if (!go) process.exit(1);
}

main();
