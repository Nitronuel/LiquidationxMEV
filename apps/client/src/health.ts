import type { FastifyInstance } from "fastify";
import Fastify from "fastify";

/** Liveness signal published by one bot per chain (see `launchBot`). */
export interface CycleStats {
  /** Time of the last *started* evaluation cycle. */
  lastRunAt: number;
  /** Time of the last *completed* evaluation cycle. */
  lastCompletedAt: number;
  /** Completed evaluation cycles since process start. */
  runs: number;
  /** Cycles that ended with an uncaught error (see `executeRun` catch). */
  errors: number;
}

interface ChainLiveness {
  chainId: number;
  label: string;
  startedAt: number;
  stats: CycleStats;
}

/** Report body returned by `GET /health`. */
export interface HealthReport {
  status: "ok" | "degraded" | "starting";
  uptimeSeconds: number;
  chains: {
    chainId: number;
    label: string;
    status: "ok" | "degraded" | "starting";
    runs: number;
    errors: number;
    secondsSinceLastRun: number;
    secondsSinceLastCompletion: number;
  }[];
}

const DAY_MS = 86_400_000;

/**
 * Registry of per-chain cycle liveness. `launchBot` registers each bot at
 * startup and calls `recordCycleStart`/`recordCycleEnd` around every evaluation
 * cycle; the health server turns the registry into `GET /health` output.
 */
class LivenessRegistry {
  private readonly chains = new Map<number, ChainLiveness>();

  register(chainId: number, label: string): void {
    this.chains.set(chainId, {
      chainId,
      label,
      startedAt: Date.now(),
      stats: { lastRunAt: 0, lastCompletedAt: 0, runs: 0, errors: 0 },
    });
  }

  recordCycleStart(chainId: number): void {
    const chain = this.chains.get(chainId);
    if (chain) chain.stats.lastRunAt = Date.now();
  }

  recordCycleEnd(chainId: number, error = false): void {
    const chain = this.chains.get(chainId);
    if (!chain) return;
    chain.stats.lastCompletedAt = Date.now();
    chain.stats.runs++;
    if (error) chain.stats.errors++;
  }

  /** Clears all registrations (test isolation). */
  reset(): void {
    this.chains.clear();
  }

  /** Report for `/health`; `now` is injectable for tests. */
  report(now = Date.now()): HealthReport {
    const chains = [...this.chains.values()].map((chain) => {
      const { lastRunAt, lastCompletedAt, runs, errors } = chain.stats;
      // Degraded = the bot booted but has never completed a cycle, or went
      // silent for a full day (a healthy 4663 cycle runs every 50–90ms; the
      // safety poll alone fires every 30s, so a 24h gap means a hang).
      const status: "ok" | "degraded" | "starting" =
        runs === 0
          ? lastRunAt > 0
            ? "degraded"
            : "starting"
          : now - lastCompletedAt > DAY_MS
            ? "degraded"
            : "ok";
      return {
        chainId: chain.chainId,
        label: chain.label,
        runs,
        errors,
        secondsSinceLastRun: lastRunAt > 0 ? (now - lastRunAt) / 1_000 : -1,
        secondsSinceLastCompletion: lastCompletedAt > 0 ? (now - lastCompletedAt) / 1_000 : -1,
        status,
      };
    });

    const overall: HealthReport["status"] =
      chains.length === 0
        ? "starting"
        : chains.some((chain) => chain.status === "degraded")
          ? "degraded"
          : "ok";

    return {
      status: overall,
      uptimeSeconds: process.uptime(),
      chains,
    };
  }
}

/** Shared registry: one per process, populated by `launchBot` for every chain. */
export const liveness = new LivenessRegistry();

class HealthServer {
  private fastify: FastifyInstance;
  private port: number;
  private host: string;

  constructor(port = 3000, host = "127.0.0.1") {
    this.port = port;
    this.host = host;
    this.fastify = Fastify({
      logger: false,
    });

    this.setupRoutes();
  }

  private setupRoutes() {
    this.fastify.get("/health", async (_request, reply) => {
      const report = liveness.report();
      // 200 when every registered bot cycles normally, 503 when a bot is hung
      // (so orchestrator healthchecks — Docker HEALTHCHECK, systemd watchdog,
      // uptime monitors — restart/alert on real failures, not just "up").
      return reply.code(report.status === "degraded" ? 503 : 200).send(report);
    });
  }

  async start() {
    try {
      await this.fastify.listen({ port: this.port, host: this.host });
      console.log(`🚀 Health server listening on http://${this.host}:${this.port}`);
    } catch (err) {
      this.fastify.log.error(err);
      throw err;
    }
  }

  async stop() {
    await this.fastify.close();
  }
}

// Singleton instance
let healthServerInstance: HealthServer | null = null;

export function getHealthServer(port?: number, host?: string): HealthServer {
  if (!healthServerInstance) {
    const serverPort =
      port ??
      Number.parseInt(
        process.env.HEALTH_PORT ?? process.env.PORT ?? process.env.HEALTH_SERVER_PORT ?? "3000",
        10,
      );
    // Loopback by default — this endpoint carries no auth and must never be
    // reachable from outside the VPS.
    const serverHost = host ?? process.env.HEALTH_SERVER_HOST ?? "127.0.0.1";
    healthServerInstance = new HealthServer(serverPort, serverHost);
  }
  return healthServerInstance;
}

export async function startHealthServer(port?: number, host?: string): Promise<HealthServer> {
  const server = getHealthServer(port, host);
  await server.start();
  return server;
}
