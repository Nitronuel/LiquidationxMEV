import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { liveness, startHealthServer } from "../../src/health.js";

describe("Health endpoint", () => {
  let healthServer: Awaited<ReturnType<typeof startHealthServer>>;
  let port: number;

  beforeAll(async () => {
    // Use a random port for testing to avoid conflicts
    port = 3001;
    healthServer = await startHealthServer(port, "127.0.0.1");
  });

  afterAll(async () => {
    await healthServer.stop();
  });

  afterEach(() => {
    liveness.reset();
  });

  it("should return 200 with status starting when no bots registered", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const data = (await response.json()) as { status: string; chains: unknown[] };
    expect(data.status).toBe("starting");
    expect(data.chains).toEqual([]);
  });

  it("should report ok for a chain with completed cycles", async () => {
    liveness.register(4663, "Robinhood");
    liveness.recordCycleStart(4663);
    liveness.recordCycleEnd(4663);

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);

    const data = (await response.json()) as {
      status: string;
      chains: { chainId: number; status: string; runs: number; errors: number }[];
    };
    expect(data.status).toBe("ok");
    expect(data.chains).toHaveLength(1);
    expect(data.chains[0]).toMatchObject({ chainId: 4663, status: "ok", runs: 1, errors: 0 });
  });

  it("should report 503 degraded when a chain started but never completed a cycle", async () => {
    liveness.register(4663, "Robinhood");
    liveness.recordCycleStart(4663); // started, hung before completion

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(503);

    const data = (await response.json()) as { status: string; chains: { status: string }[] };
    expect(data.status).toBe("degraded");
    expect(data.chains[0]?.status).toBe("degraded");
  });

  it("should report degraded when the last completion is stale", () => {
    liveness.register(4663, "Robinhood");
    liveness.recordCycleStart(4663);
    liveness.recordCycleEnd(4663);

    // Reporting from >24h in the future means the last completed cycle is a
    // day old — the cycle loop is hung even though runs > 0.
    const report = liveness.report(Date.now() + 25 * 3_600_000);
    expect(report.chains[0]?.status).toBe("degraded");
  });

  it("should count errors without dropping the cycle", async () => {
    liveness.register(4663, "Robinhood");
    liveness.recordCycleStart(4663);
    liveness.recordCycleEnd(4663, true);

    const report = liveness.report();
    expect(report.status).toBe("ok"); // errors alone don't mark degraded
    expect(report.chains[0]).toMatchObject({ runs: 1, errors: 1 });
  });

  it("should degrade overall when any registered chain is degraded", () => {
    liveness.register(1, "Mainnet");
    liveness.recordCycleStart(1);
    liveness.recordCycleEnd(1);
    liveness.register(4663, "Robinhood");
    liveness.recordCycleStart(4663); // hung

    const report = liveness.report();
    expect(report.status).toBe("degraded");
  });
});
