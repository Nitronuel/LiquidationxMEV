import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  aggregateDailyReport,
  previousUtcDate,
  readRecentTrades,
  renderDailyReport,
  renderNearLiquidations,
  renderRecentTrades,
} from "../../src/utils/dailyReport";

describe("aggregateDailyReport", () => {
  let dir: string;
  let metricsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daily-report-"));
    metricsPath = join(dir, "metrics.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeMetrics = (lines: unknown[]) => {
    writeFileSync(metricsPath, lines.map((line) => JSON.stringify(line)).join("\n"));
  };

  it("returns zeroed stats when the metrics file is missing", () => {
    const stats = aggregateDailyReport(undefined, "2026-08-23");
    expect(stats).toEqual({
      date: "2026-08-23",
      radarPeak: 0,
      lowestHealthFactor: undefined,
      attempted: 0,
      attemptedUnique: 0,
      successful: 0,
      totalProfitUsd: 0,
      totalGasUsd: 0,
      netProfitUsd: 0,
      bestSingleUsd: undefined,
      observedTotal: 0,
      observedSelf: 0,
      observedLost: 0,
      observedUnwatched: 0,
      topLiquidator: undefined,
    });
  });

  it("aggregates radar and liquidation events for the requested UTC day only", () => {
    writeMetrics([
      // Previous day — must be ignored entirely.
      { ts: "2026-08-22T23:59:59.000Z", type: "radar", count: 99 },
      {
        ts: "2026-08-22T12:00:00.000Z",
        type: "liquidation",
        outcome: "executed",
        profitUsd: 500,
        gasUsd: 5,
      },
      // Target day.
      { ts: "2026-08-23T00:00:01.000Z", type: "radar", count: 61, positions: [] },
      {
        ts: "2026-08-23T01:00:00.000Z",
        type: "radar",
        count: 40,
        positions: [
          { healthFactor: "1006182007511300782" },
          { healthFactor: "981200000000000000" },
        ],
      },
      {
        ts: "2026-08-23T02:00:00.000Z",
        type: "liquidation",
        outcome: "sim_failed",
        user: "0xabc",
      },
      {
        ts: "2026-08-23T03:00:00.000Z",
        type: "liquidation",
        outcome: "skipped_unprofitable",
        user: "0xabc",
      },
      {
        ts: "2026-08-23T04:00:00.000Z",
        type: "liquidation",
        outcome: "executed",
        profitUsd: 141.63,
        gasUsd: 1.23,
      },
      {
        ts: "2026-08-23T05:00:00.000Z",
        type: "pre_liquidation",
        outcome: "executed",
        profitUsd: 10,
        gasUsd: 0.5,
      },
      {
        ts: "2026-08-23T06:00:00.000Z",
        type: "liquidation",
        outcome: "failed",
        error: "nonce too low",
      },
      // Next day — must be ignored.
      {
        ts: "2026-08-24T00:00:01.000Z",
        type: "liquidation",
        outcome: "executed",
        profitUsd: 9999,
        gasUsd: 1,
      },
    ]);

    const stats = aggregateDailyReport(metricsPath, "2026-08-23");

    expect(stats.radarPeak).toBe(61);
    expect(stats.lowestHealthFactor).toBe(981200000000000000n);
    expect(stats.attempted).toBe(5);
    expect(stats.successful).toBe(2);
    expect(stats.totalGasUsd).toBeCloseTo(1.73, 10);
    expect(stats.netProfitUsd).toBeCloseTo(151.63, 10);
    // Gross profit = net + gas.
    expect(stats.totalProfitUsd).toBeCloseTo(153.36, 10);
    expect(stats.bestSingleUsd).toBeCloseTo(141.63, 10);
  });

  it("aggregates observed competitor liquidations with radar joins", () => {
    writeMetrics([
      // Our own trade — counted, excluded from competitor stats.
      {
        ts: "2026-08-23T01:00:00.000Z",
        type: "liquidation_observed",
        caller: "0xEXECUTOR",
        self: true,
        radarSeen: true,
      },
      // Lost race: was on our radar.
      {
        ts: "2026-08-23T02:00:00.000Z",
        type: "liquidation_observed",
        caller: "0xRIVAL1",
        self: false,
        radarSeen: true,
      },
      // Coverage gap: never on our radar.
      {
        ts: "2026-08-23T03:00:00.000Z",
        type: "liquidation_observed",
        caller: "0xRIVAL2",
        self: false,
        radarSeen: false,
      },
      // RIVAL1 again — top liquidator with 2 trades.
      {
        ts: "2026-08-23T04:00:00.000Z",
        type: "liquidation_observed",
        caller: "0xRIVAL1",
        self: false,
        radarSeen: true,
      },
      // Different day — ignored.
      {
        ts: "2026-08-24T01:00:00.000Z",
        type: "liquidation_observed",
        caller: "0xRIVAL3",
        self: false,
        radarSeen: false,
      },
    ]);

    const stats = aggregateDailyReport(metricsPath, "2026-08-23");
    expect(stats.observedTotal).toBe(4);
    expect(stats.observedSelf).toBe(1);
    expect(stats.observedLost).toBe(2);
    expect(stats.observedUnwatched).toBe(1);
    expect(stats.topLiquidator).toEqual({ caller: "0xRIVAL1", count: 2 });
  });

  it("renders the competitor section only when liquidations were observed", () => {
    const stats = aggregateDailyReport(undefined, "2026-08-23");
    stats.radarPeak = 5;
    let report = renderDailyReport(stats);
    expect(report).not.toContain("observed on-chain");

    stats.observedTotal = 3;
    stats.observedSelf = 1;
    stats.observedLost = 2;
    stats.observedUnwatched = 0;
    stats.topLiquidator = { caller: "0xRIVAL1", count: 2 };
    report = renderDailyReport(stats);
    expect(report).toContain(
      "🕵️ Liquidations observed on-chain: 3 (ours: 1, lost: 2, unwatched: 0)",
    );
    expect(report).toContain("Top liquidator: 0xRIVAL1 (2 trades)");
  });

  it("skips malformed lines without throwing", () => {
    writeFileSync(
      metricsPath,
      [
        "not json at all",
        JSON.stringify({ ts: "2026-08-23T00:00:00.000Z", type: "radar", count: 3 }),
        JSON.stringify({
          ts: "2026-08-23T01:00:00.000Z",
          type: "liquidation",
          outcome: "executed",
          profitUsd: 1,
        }),
      ].join("\n"),
    );

    const stats = aggregateDailyReport(metricsPath, "2026-08-23");
    expect(stats.radarPeak).toBe(3);
    expect(stats.successful).toBe(1);
  });
});

describe("renderDailyReport", () => {
  it("renders the ops report layout with all fields", () => {
    const stats = aggregateDailyReport(undefined, "2026-08-23");
    stats.radarPeak = 61;
    stats.lowestHealthFactor = 981200000000000000n;
    stats.attempted = 3;
    stats.successful = 1;
    stats.totalProfitUsd = 142.86;
    stats.totalGasUsd = 1.23;
    stats.netProfitUsd = 141.63;
    stats.bestSingleUsd = 141.63;

    const report = renderDailyReport(stats);

    expect(report).toBe(
      [
        "📊 Daily Liquidation Report — 2026-08-23 UTC",
        "",
        "├── Total positions on radar: 61",
        "├── Liquidations attempted: 3",
        "├── Successful liquidations: 1",
        "├── Total profit: $142.86",
        "├── Total gas spent: $1.23",
        "├── Net profit: $141.63",
        "├── Lowest HF seen: 0.9812",
        "└── Best single liquidation: $141.63",
      ].join("\n"),
    );
  });

  it("renders dashes for a day with no activity", () => {
    const report = renderDailyReport(aggregateDailyReport(undefined, "2026-08-23"));
    expect(report).toContain("Lowest HF seen: —");
    expect(report).toContain("Best single liquidation: —");
  });
});

describe("previousUtcDate", () => {
  it("handles month boundaries", () => {
    expect(previousUtcDate("2026-08-01")).toBe("2026-07-31");
    expect(previousUtcDate("2026-01-01")).toBe("2025-12-31");
    expect(previousUtcDate("2026-08-24")).toBe("2026-08-23");
  });
});

describe("readRecentTrades", () => {
  let dir: string;
  let metricsPath: string;

  const writeMetrics = (lines: unknown[]) => {
    writeFileSync(metricsPath, lines.map((line) => JSON.stringify(line)).join("\n"));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "recent-trades-"));
    metricsPath = join(dir, "metrics.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the last N executed/failed trades, filtering everything else", () => {
    writeMetrics([
      { ts: "2026-08-24T09:00:00.000Z", type: "liquidation", outcome: "sim_failed" },
      {
        ts: "2026-08-24T09:01:00.000Z",
        type: "liquidation",
        outcome: "executed",
        user: "0xaaa",
        profitUsd: 8.3,
        gasUsd: 0.02,
      },
      { ts: "2026-08-24T09:02:00.000Z", type: "pre_liquidation", outcome: "dry_run" },
      { ts: "2026-08-24T09:03:00.000Z", type: "liquidation_observed", outcome: "executed" },
      { ts: "2026-08-24T09:04:00.000Z", type: "liquidation", outcome: "failed", user: "0xbbb" },
      {
        ts: "2026-08-24T09:05:00.000Z",
        type: "pre_liquidation",
        outcome: "executed",
        user: "0xccc",
        profitUsd: 1.1,
      },
    ]);
    const trades = readRecentTrades(metricsPath, 5);
    expect(trades).toHaveLength(3);
    expect(trades[0]).toMatchObject({ outcome: "executed", user: "0xaaa" });
    expect(trades[2]).toMatchObject({
      outcome: "executed",
      user: "0xccc",
      kind: "pre_liquidation",
    });

    expect(readRecentTrades(metricsPath, 2)).toHaveLength(2);
    expect(readRecentTrades(undefined, 5)).toEqual([]);
  });
});

describe("renderRecentTrades", () => {
  it("renders empty state and trade lines", () => {
    expect(renderRecentTrades([])).toContain("No trades yet");
    const report = renderRecentTrades([
      {
        ts: "2026-08-24T09:31:22.000Z",
        kind: "liquidation",
        outcome: "executed",
        user: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        profitUsd: 8.3,
        gasUsd: 0.015,
      },
      {
        ts: "2026-08-24T09:31:30.000Z",
        kind: "liquidation",
        outcome: "failed",
        user: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    ]);
    expect(report).toContain("📜 Recent trades");
    expect(report).toContain("09:31:22  0xaaa…aaaa  ✅ LIQ +$8.30 (gas $0.0150)");
    expect(report).toContain("09:31:30  0xbbb…bbbb  ❌ LIQ reverted");
  });
});

describe("renderNearLiquidations", () => {
  const position = (user: string, hf: string, borrow: string) =>
    ({
      user: `0x${user}00000000000000000000000000000000000000`,
      marketId: "0xmarket",
      loanToken: "0xusdg",
      healthFactor: hf,
      collateral: "1",
      borrowAssets: borrow,
    }) as const;

  it("renders empty state", () => {
    expect(renderNearLiquidations([], 0, new Map())).toContain("Radar is empty");
  });

  it("sorts by lowest HF, computes drop %, and humanizes debt", () => {
    const report = renderNearLiquidations(
      [
        position("b", "1023000000000000000", "4200000000"), // HF 1.023, debt 4,200
        position("a", "1006400000000000000", "20100000000000"), // HF 1.0064, debt 20.1M
      ],
      59,
      new Map([["0xusdg", 6]]),
    );
    const lines = report.split("\n");
    expect(lines[0]).toContain("Top 2 near-liquidation (59 watching)");
    expect(lines[0]).not.toContain("dust filtered");
    expect(lines[2]).toContain("1. 0xa00…0000  HF 1.0064  drop 0.64%  debt $20.1M");
    expect(lines[3]).toContain("2. 0xb00…0000  HF 1.0230  drop 2.25%  debt $4,200");
  });

  it("filters dust positions out of the ranking", () => {
    const report = renderNearLiquidations(
      [
        position("dust1", "1000000000000000000", "1"), // 1 wei — HF pinned at 1.0
        position("dust2", "1000000000000000000", "3"), // 3 wei
        position("real", "1012000000000000000", "5000000"), // HF 1.012, debt $5
      ],
      60,
      new Map([["0xusdg", 6]]),
    );
    const lines = report.split("\n");
    expect(lines[0]).toContain("Top 1 near-liquidation (60 watching, 2 dust filtered)");
    expect(lines[2]).toContain("HF 1.0120");
    expect(report).not.toContain("dust1");
  });

  it("reports the all-dust state", () => {
    const report = renderNearLiquidations(
      [
        position("dust1", "1000000000000000000", "1"),
        position("dust2", "1000000000000000000", "2"),
      ],
      60,
      new Map([["0xusdg", 6]]),
    );
    expect(report).toContain("60 positions watching — all dust (debt < $0.50)");
  });

  it("defaults to 18 decimals when the token is unknown", () => {
    const report = renderNearLiquidations(
      [position("a", "1000000000000000000", "500000000000000000")], // 0.5 tokens
      1,
      new Map(),
    );
    expect(report).toContain("debt $0.50");
  });
});
