import {
  aggregateDailyReport,
  readRecentTrades,
  renderDailyReport,
  renderNearLiquidations,
  renderRecentTrades,
  type NearLiquidationSnapshot,
} from "./dailyReport.js";
import { parseTelegramCommand, TelegramSubscriberRegistry } from "./telegramSubscribers.js";

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
  };
}

/**
 * Fire-and-forget Telegram notifications via the raw Bot API (no SDK — the
 * bot's messaging needs are `sendMessage` + `getUpdates` long-polling).
 * Every send is wrapped so a Telegram outage can never throw into, or block,
 * the trading hot path. Messages are broadcast to all subscribers in the
 * registry (seeded with the owner's chat ID).
 */
export class TelegramNotifier {
  private readonly apiBase: string;
  private readonly chatId: string;
  private readonly logTag: string;
  private readonly registry?: TelegramSubscriberRegistry;
  private polling = false;

  /** Telegram drops messages past 4096 characters. */
  private static readonly MAX_MESSAGE_CHARS = 4096;
  private static readonly TIMEOUT_MS = 10_000;
  private static readonly LONG_POLL_SECONDS = 25;
  private static readonly POLL_ERROR_BACKOFF_MS = 5_000;

  constructor(inputs: {
    botToken: string;
    chatId: string;
    logTag: string;
    registry?: TelegramSubscriberRegistry;
  }) {
    this.apiBase = `https://api.telegram.org/bot${inputs.botToken}`;
    this.chatId = inputs.chatId;
    this.logTag = inputs.logTag;
    this.registry = inputs.registry;
  }

  private recipients(): string[] {
    const list = this.registry ? this.registry.all() : [this.chatId];
    return list.length > 0 ? list : [this.chatId];
  }

  /** Broadcasts to every subscriber; per-recipient failures are isolated. */
  async send(text: string): Promise<void> {
    await Promise.all(this.recipients().map((chatId) => this.sendTo(chatId, text)));
  }

  private async sendTo(chatId: string, text: string): Promise<void> {
    try {
      const response = await fetch(`${this.apiBase}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.slice(0, TelegramNotifier.MAX_MESSAGE_CHARS),
        }),
        signal: AbortSignal.timeout(TelegramNotifier.TIMEOUT_MS),
      });
      if (!response.ok) {
        console.error(
          `${this.logTag}telegram sendMessage failed: HTTP ${response.status} ${await response.text()}`,
        );
      }
    } catch (error) {
      console.error(`${this.logTag}telegram sendMessage error:`, error);
    }
  }

  /** Immediate alert for a real trade event (broadcast executed or failed). */
  async sendTradeAlert(event: {
    kind: "liquidation" | "pre_liquidation";
    outcome: "executed" | "failed";
    user: string;
    marketId: string;
    profitUsd?: number;
    gasUsd?: number;
    txHash?: string;
    latencyMs?: number;
    error?: string;
  }): Promise<void> {
    const title =
      event.outcome === "executed" ? "🎯 LIQUIDATION EXECUTED" : "❌ LIQUIDATION FAILED";
    const kind = event.kind === "pre_liquidation" ? "pre-liquidation" : "liquidation";
    const lines = [
      title,
      `├── Type: ${kind}`,
      `├── Position: ${event.user}`,
      `├── Market: ${event.marketId}`,
    ];
    if (event.profitUsd !== undefined) {
      // profitUsd is already net of gas; gross = net + gas.
      const gross = event.gasUsd !== undefined ? event.profitUsd + event.gasUsd : event.profitUsd;
      lines.push(`├── Profit: $${gross.toFixed(2)} → net $${event.profitUsd.toFixed(2)}`);
    }
    if (event.gasUsd !== undefined) lines.push(`├── Gas: $${event.gasUsd.toFixed(4)}`);
    if (event.txHash !== undefined) lines.push(`├── Tx: ${event.txHash}`);
    if (event.latencyMs !== undefined) lines.push(`├── Latency: ${event.latencyMs}ms`);
    if (event.error !== undefined) lines.push(`├── Error: ${event.error.slice(0, 300)}`);
    lines.push(`└── Time: ${new Date().toISOString()}`);
    await this.send(lines.join("\n"));
  }

  /** Alert when a watched position was liquidated by a competitor. */
  async sendLostAlert(event: {
    borrower: string;
    marketId: string;
    winnerTx: string;
    debtDisplay?: string;
    ourAttempt?: string;
  }): Promise<void> {
    const lines = [
      "❌ LIQUIDATION LOST",
      `├── Position: ${event.borrower}`,
      `├── Market: ${event.marketId}`,
      `├── Winner tx: ${event.winnerTx}`,
    ];
    if (event.debtDisplay !== undefined) lines.push(`├── Debt: ${event.debtDisplay}`);
    if (event.ourAttempt !== undefined) lines.push(`├── Our attempt: ${event.ourAttempt}`);
    lines.push(`└── Time: ${new Date().toISOString()}`);
    await this.send(lines.join("\n"));
  }

  /**
   * Subscribes chat owners via `/start <secret>` and serves `/stop` +
   * `/status`. Long-polls getUpdates in the background; all failures are
   * logged and retried — never propagated. A 409 (another poller consuming
   * this bot, e.g. a second chain process) disables polling permanently.
   */
  startCommandPolling(inputs: {
    secret?: string;
    metricsPath?: string;
    getRadarSnapshot?: () => readonly NearLiquidationSnapshot[];
    resolveTokenDecimals?: (token: string) => Promise<number | undefined>;
  }): void {
    if (this.polling) return;
    this.polling = true;
    console.log(
      `${this.logTag}📣 Telegram command polling enabled (/start /stop /status /near /log)`,
    );
    void this.pollLoop(inputs);
  }

  private async pollLoop(inputs: {
    secret?: string;
    metricsPath?: string;
    getRadarSnapshot?: () => readonly NearLiquidationSnapshot[];
    resolveTokenDecimals?: (token: string) => Promise<number | undefined>;
  }): Promise<void> {
    let offset = 0;
    while (true) {
      let updates: TelegramUpdate[] | undefined;
      try {
        const response = await fetch(
          `${this.apiBase}/getUpdates?timeout=${TelegramNotifier.LONG_POLL_SECONDS}&offset=${offset}&allowed_updates=%5B%22message%22%5D`,
          { signal: AbortSignal.timeout((TelegramNotifier.LONG_POLL_SECONDS + 10) * 1_000) },
        );
        if (response.status === 409) {
          console.error(
            `${this.logTag}telegram getUpdates conflict (another process is polling this bot) — command polling disabled`,
          );
          return;
        }
        if (!response.ok) {
          console.error(`${this.logTag}telegram getUpdates failed: HTTP ${response.status}`);
        } else {
          updates = ((await response.json()) as { result?: TelegramUpdate[] }).result;
        }
      } catch (error) {
        console.error(`${this.logTag}telegram getUpdates error:`, error);
      }

      if (updates) {
        for (const update of updates) {
          offset = update.update_id + 1;
          await this.handleUpdate(update, inputs);
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, TelegramNotifier.POLL_ERROR_BACKOFF_MS));
      }
    }
  }

  private async handleUpdate(
    update: TelegramUpdate,
    inputs: {
      secret?: string;
      metricsPath?: string;
      getRadarSnapshot?: () => readonly NearLiquidationSnapshot[];
      resolveTokenDecimals?: (token: string) => Promise<number | undefined>;
    },
  ): Promise<void> {
    const message = update.message;
    if (!message?.text) return;
    const chatId = String(message.chat.id);
    const parsed = parseTelegramCommand(message.text);
    if (!parsed) return;

    switch (parsed.command) {
      case "/start": {
        if (!inputs.secret || parsed.arg !== inputs.secret) {
          console.warn(`${this.logTag}telegram /start rejected for chat ${chatId} (bad secret)`);
          await this.sendTo(chatId, "❌ Invalid or missing secret. Use /start <secret>.");
          return;
        }
        if (this.registry?.add(chatId)) {
          console.log(`${this.logTag}telegram subscriber added: ${chatId}`);
          await this.sendTo(
            chatId,
            "✅ Subscribed! You will receive trade alerts and daily reports. Send /stop to unsubscribe.",
          );
        } else {
          await this.sendTo(chatId, "You are already subscribed.");
        }
        return;
      }
      case "/stop": {
        if (this.registry?.remove(chatId)) {
          console.log(`${this.logTag}telegram subscriber removed: ${chatId}`);
          await this.sendTo(chatId, "Unsubscribed. Send /start <secret> to resubscribe.");
        } else {
          await this.sendTo(chatId, "You are not subscribed.");
        }
        return;
      }
      case "/status": {
        if (!(await this.gateSubscriber(chatId))) return;
        const today = new Date().toISOString().slice(0, 10);
        const report = renderDailyReport(aggregateDailyReport(inputs.metricsPath, today));
        await this.sendTo(chatId, report);
        return;
      }
      case "/near": {
        if (!(await this.gateSubscriber(chatId))) return;
        const snapshot = inputs.getRadarSnapshot?.() ?? [];
        const decimals = new Map<string, number>();
        for (const token of new Set(snapshot.map((p) => p.loanToken.toLowerCase()))) {
          const resolved = await inputs.resolveTokenDecimals?.(token);
          if (resolved !== undefined) decimals.set(token, resolved);
          else
            console.warn(
              `${this.logTag}telegram /near: decimals lookup failed for ${token} — defaulting to 18`,
            );
        }
        await this.sendTo(chatId, renderNearLiquidations(snapshot, snapshot.length, decimals));
        return;
      }
      case "/log": {
        if (!(await this.gateSubscriber(chatId))) return;
        await this.sendTo(chatId, renderRecentTrades(readRecentTrades(inputs.metricsPath, 5)));
        return;
      }
      default:
        // Unknown commands and plain messages are ignored silently.
        return;
    }
  }

  /** Subscriber gate for on-demand commands. Sends the rejection when false. */
  private async gateSubscriber(chatId: string): Promise<boolean> {
    if (this.registry && !this.registry.has(chatId)) {
      await this.sendTo(chatId, "❌ Not subscribed. Use /start <secret> first.");
      return false;
    }
    return true;
  }
}
