import { existsSync, readFileSync } from "node:fs";

import type { Address, Hex } from "viem";

/** A near-liquidation position, as served by the /near Telegram command. */
export interface NearLiquidationSnapshot {
  user: Address;
  marketId: Hex;
  loanToken: Address;
  /** WAD-scaled health factor (raw string). */
  healthFactor: string;
  /** Raw collateral amount. */
  collateral: string;
  /** Raw borrow amount, denominated in the loan token. */
  borrowAssets: string;
}

export interface RecentTrade {
  ts: string;
  kind: string;
  outcome: string;
  user?: string;
  marketId?: string;
  profitUsd?: number;
  gasUsd?: number;
}

export interface DailyReportStats {
  /** UTC date the report covers, e.g. "2026-08-23". */
  date: string;
  /** Highest near-liquidation radar count observed during the day. */
  radarPeak: number;
  /** Lowest health factor seen on radar, scaled by WAD (raw string). */
  lowestHealthFactor?: bigint;
  /** Liquidation + pre-liquidation attempts (any outcome). */
  attempted: number;
  /** Distinct positions attempted. */
  attemptedUnique: number;
  /** Broadcasts that executed on-chain. */
  successful: number;
  /** Gross profit before gas (USD). */
  totalProfitUsd: number;
  /** Gas spent on executed trades (USD). */
  totalGasUsd: number;
  /** Net profit after gas (USD). */
  netProfitUsd: number;
  /** Best single executed liquidation, net of gas (USD). */
  bestSingleUsd?: number;
  /** Liquidations observed on-chain (any liquidator, including ours). */
  observedTotal: number;
  /** Observed liquidations executed by our own executor. */
  observedSelf: number;
  /** Observed liquidations on positions that were on our radar — we saw them tip and lost the race. */
  observedLost: number;
  /** Observed liquidations on positions never on our radar — a coverage gap. */
  observedUnwatched: number;
  /** Most active non-self liquidator of the day. */
  topLiquidator?: { caller: string; count: number };
}

interface MetricEvent {
  ts?: string;
  type?: string;
  outcome?: string;
  count?: number;
  profitUsd?: number;
  gasUsd?: number;
  positions?: { healthFactor?: string }[];
  caller?: string;
  self?: boolean;
  radarSeen?: boolean;
  user?: string;
  marketId?: string;
}

/**
 * Aggregates one UTC day of metrics.jsonl records into daily-report stats.
 * `profitUsd` from the bot is already net of gas, so gross = net + gas and
 * net = Σ profitUsd.
 */
export function aggregateDailyReport(
  metricsPath: string | undefined,
  utcDate: string,
): DailyReportStats {
  const stats: DailyReportStats = {
    date: utcDate,
    radarPeak: 0,
    attempted: 0,
    attemptedUnique: 0,
    successful: 0,
    totalProfitUsd: 0,
    totalGasUsd: 0,
    netProfitUsd: 0,
    observedTotal: 0,
    observedSelf: 0,
    observedLost: 0,
    observedUnwatched: 0,
  };

  if (!metricsPath || !existsSync(metricsPath)) return stats;

  const callerCounts = new Map<string, number>();
  const uniquePositions = new Set<string>();
  for (const line of readFileSync(metricsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: MetricEvent;
    try {
      ev = JSON.parse(line) as MetricEvent;
    } catch {
      continue;
    }
    if (ev.ts?.slice(0, 10) !== utcDate) continue;

    if (ev.type === "radar") {
      if (typeof ev.count === "number" && ev.count > stats.radarPeak) stats.radarPeak = ev.count;
      for (const position of ev.positions ?? []) {
        if (position.healthFactor === undefined) continue;
        try {
          const hf = BigInt(position.healthFactor);
          if (stats.lowestHealthFactor === undefined || hf < stats.lowestHealthFactor)
            stats.lowestHealthFactor = hf;
        } catch {
          // skip malformed health factor
        }
      }
      continue;
    }

    if (ev.type === "liquidation_observed") {
      aggregateObserved(stats, ev, callerCounts);
      continue;
    }

    if (ev.type !== "liquidation" && ev.type !== "pre_liquidation") continue;
    stats.attempted++;
    if (ev.user && ev.marketId) uniquePositions.add(`${ev.user}@${ev.marketId}`);
    if (ev.outcome !== "executed") continue;
    stats.successful++;
    const gasUsd = typeof ev.gasUsd === "number" ? ev.gasUsd : 0;
    const netUsd = typeof ev.profitUsd === "number" ? ev.profitUsd : 0;
    stats.totalGasUsd += gasUsd;
    stats.netProfitUsd += netUsd;
    stats.totalProfitUsd += netUsd + gasUsd;
    if (stats.bestSingleUsd === undefined || netUsd > stats.bestSingleUsd)
      stats.bestSingleUsd = netUsd;
  }

  let top: { caller: string; count: number } | undefined;
  for (const [caller, count] of callerCounts) {
    if (top === undefined || count > top.count) top = { caller, count };
  }
  stats.topLiquidator = top;
  stats.attemptedUnique = uniquePositions.size;

  return stats;
}

/** Aggregates one observed on-chain liquidation into stats (competitor intel). */
function aggregateObserved(
  stats: DailyReportStats,
  ev: MetricEvent,
  callerCounts: Map<string, number>,
): void {
  stats.observedTotal++;
  if (ev.self) {
    stats.observedSelf++;
    return;
  }
  if (ev.radarSeen) stats.observedLost++;
  else stats.observedUnwatched++;
  if (!ev.caller) return;
  callerCounts.set(ev.caller, (callerCounts.get(ev.caller) ?? 0) + 1);
}

/** Renders the daily report as a fixed-width block matching the ops report format. */
export function renderDailyReport(stats: DailyReportStats): string {
  const hf =
    stats.lowestHealthFactor === undefined
      ? "—"
      : (Number(stats.lowestHealthFactor) / 1e18).toFixed(4);
  const money = (value: number | undefined) => (value === undefined ? "—" : `$${value.toFixed(2)}`);

  const attemptedLine =
    stats.attemptedUnique > 0 && stats.attemptedUnique !== stats.attempted
      ? `├── Liquidations attempted: ${stats.attempted} (${stats.attemptedUnique} unique)`
      : `├── Liquidations attempted: ${stats.attempted}`;
  const lines = [
    `📊 Daily Liquidation Report — ${stats.date} UTC`,
    "",
    `├── Total positions on radar: ${stats.radarPeak}`,
    attemptedLine,
    `├── Successful liquidations: ${stats.successful}`,
    `├── Total profit: ${money(stats.totalProfitUsd)}`,
    `├── Total gas spent: ${money(stats.totalGasUsd)}`,
    `├── Net profit: ${money(stats.netProfitUsd)}`,
    `├── Lowest HF seen: ${hf}`,
    `└── Best single liquidation: ${money(stats.bestSingleUsd)}`,
  ];

  if (stats.observedTotal > 0) {
    lines.push(
      "",
      `🕵️ Liquidations observed on-chain: ${stats.observedTotal} (ours: ${stats.observedSelf}, lost: ${stats.observedLost}, unwatched: ${stats.observedUnwatched})`,
    );
    if (stats.topLiquidator)
      lines.push(
        `└── Top liquidator: ${stats.topLiquidator.caller} (${stats.topLiquidator.count} trades)`,
      );
  }

  return lines.join("\n");
}

/** Returns the UTC date string (YYYY-MM-DD) for the day before `utcDate`. */
export function previousUtcDate(utcDate: string): string {
  const date = new Date(`${utcDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** Reads the most recent real trades (executed/failed broadcasts) from the metrics log. */
export function readRecentTrades(metricsPath: string | undefined, limit: number): RecentTrade[] {
  if (!metricsPath || !existsSync(metricsPath)) return [];
  const trades: RecentTrade[] = [];
  for (const line of readFileSync(metricsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: MetricEvent & {
      user?: string;
      marketId?: string;
    };
    try {
      ev = JSON.parse(line) as MetricEvent & { user?: string; marketId?: string };
    } catch {
      continue;
    }
    if (ev.ts === undefined) continue;
    if (ev.type !== "liquidation" && ev.type !== "pre_liquidation") continue;
    if (ev.outcome !== "executed" && ev.outcome !== "failed") continue;
    trades.push({
      ts: ev.ts,
      kind: ev.type,
      outcome: ev.outcome,
      user: ev.user,
      marketId: ev.marketId,
      profitUsd: typeof ev.profitUsd === "number" ? ev.profitUsd : undefined,
      gasUsd: typeof ev.gasUsd === "number" ? ev.gasUsd : undefined,
    });
  }
  return trades.slice(-limit);
}

/** Renders the /log reply: one line per recent trade. */
export function renderRecentTrades(trades: RecentTrade[]): string {
  if (trades.length === 0) return "📜 No trades yet.";
  const short = (value: string | undefined) =>
    value === undefined ? "?" : `${value.slice(0, 5)}…${value.slice(-4)}`;
  const lines = ["📜 Recent trades", ""];
  for (const trade of trades) {
    const time = trade.ts.slice(11, 19);
    const kind = trade.kind === "pre_liquidation" ? "PRE" : "LIQ";
    if (trade.outcome === "executed") {
      const profit = trade.profitUsd !== undefined ? ` +$${trade.profitUsd.toFixed(2)}` : "";
      const gas = trade.gasUsd !== undefined ? ` (gas $${trade.gasUsd.toFixed(4)})` : "";
      lines.push(`${time}  ${short(trade.user)}  ✅ ${kind}${profit}${gas}`);
    } else {
      lines.push(`${time}  ${short(trade.user)}  ❌ ${kind} reverted`);
    }
  }
  return lines.join("\n");
}

/** Compact USD-ish formatting for debt display ($20.1M / $4,200 / $89.50). */
function formatDebt(amount: number): string {
  if (amount >= 1e6) return `$${(amount / 1e6).toFixed(1)}M`;
  if (amount >= 1_000) return `$${Math.round(amount).toLocaleString("en-US")}`;
  return `$${amount.toFixed(2)}`;
}

/**
 * Renders the /near reply: non-dust positions sorted by lowest health factor,
 * with the additional price drop needed to tip below HF 1.0 (`1 − 1/HF`).
 * Dust positions (debt below the $0.50 profit floor — e.g. 1-wei borrows whose
 * HF saturates at exactly 1.0000) are excluded from the ranking so they cannot
 * crowd out real opportunities.
 */
export function renderNearLiquidations(
  positions: readonly NearLiquidationSnapshot[],
  watching: number,
  decimalsByToken: ReadonlyMap<string, number>,
): string {
  if (positions.length === 0) return "🔎 Radar is empty — no positions near liquidation right now.";

  const DUST_FLOOR_USD = 0.5;
  const debtOf = (position: NearLiquidationSnapshot): number => {
    const decimals = decimalsByToken.get(position.loanToken.toLowerCase()) ?? 18;
    return Number(BigInt(position.borrowAssets)) / 10 ** decimals;
  };

  const real = positions.filter((position) => debtOf(position) >= DUST_FLOOR_USD);
  const dust = positions.length - real.length;
  if (real.length === 0)
    return `🔎 ${watching} positions watching — all dust (debt < $${DUST_FLOOR_USD.toFixed(2)}).`;

  const sorted = [...real].sort((a, b) => Number(BigInt(a.healthFactor) - BigInt(b.healthFactor)));
  const lines = [
    `🔎 Top ${Math.min(5, sorted.length)} near-liquidation (${watching} watching${dust > 0 ? `, ${dust} dust filtered` : ""})`,
    "",
  ];
  sorted.slice(0, 5).forEach((position, index) => {
    const hf = Number(BigInt(position.healthFactor)) / 1e18;
    const dropPct = (1 - 1 / hf) * 100;
    const debt = formatDebt(debtOf(position));
    const user = `${position.user.slice(0, 5)}…${position.user.slice(-4)}`;
    lines.push(
      `${index + 1}. ${user}  HF ${hf.toFixed(4)}  drop ${dropPct.toFixed(2)}%  debt ${debt}`,
    );
  });
  return lines.join("\n");
}
