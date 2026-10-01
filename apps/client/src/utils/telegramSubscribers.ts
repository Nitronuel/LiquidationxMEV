import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface SubscriberFile {
  subscribers: string[];
}

/**
 * Persisted list of Telegram chat IDs that receive bot reports. Backward
 * compatible: the seed chat (TELEGRAM_CHAT_ID) is always present. When no
 * path is configured the registry is in-memory only (seed chat survives,
 * new subscriptions do not).
 */
export class TelegramSubscriberRegistry {
  private readonly subscribers = new Set<string>();

  constructor(
    private readonly path: string | undefined,
    private readonly logTag: string,
    seedChatId?: string,
  ) {
    this.load();
    if (seedChatId) this.add(seedChatId);
  }

  all(): string[] {
    return [...this.subscribers];
  }

  has(chatId: string): boolean {
    return this.subscribers.has(chatId);
  }

  add(chatId: string): boolean {
    if (this.subscribers.has(chatId)) return false;
    this.subscribers.add(chatId);
    this.persist();
    return true;
  }

  remove(chatId: string): boolean {
    if (!this.subscribers.has(chatId)) return false;
    this.subscribers.delete(chatId);
    this.persist();
    return true;
  }

  private load() {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const file = JSON.parse(readFileSync(this.path, "utf8")) as SubscriberFile;
      for (const chatId of file.subscribers ?? []) {
        if (typeof chatId === "string") this.subscribers.add(chatId);
      }
    } catch (error) {
      console.error(`${this.logTag}failed to read telegram subscribers file:`, error);
    }
  }

  private persist() {
    if (!this.path) return;
    try {
      const dir = dirname(this.path);
      if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      const file: SubscriberFile = { subscribers: this.all() };
      writeFileSync(this.path, `${JSON.stringify(file, null, 2)}\n`);
    } catch (error) {
      console.error(`${this.logTag}failed to write telegram subscribers file:`, error);
    }
  }
}

/** Parses a bot command message into its command and first argument. */
export function parseTelegramCommand(
  text: string | undefined,
): { command: string; arg: string } | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [command, arg = ""] = trimmed.split(/\s+/, 2);
  const base = command!.split("@", 1)[0]!.toLowerCase();
  return { command: base, arg };
}
