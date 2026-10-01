import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import nock from "nock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TelegramNotifier } from "../../src/utils/telegram";
import {
  parseTelegramCommand,
  TelegramSubscriberRegistry,
} from "../../src/utils/telegramSubscribers";

describe("TelegramSubscriberRegistry", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tg-subscribers-"));
    path = join(dir, "subscribers.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("seeds the owner chat and persists it", () => {
    const registry = new TelegramSubscriberRegistry(path, "[t]: ", "111");
    expect(registry.all()).toEqual(["111"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ subscribers: ["111"] });
  });

  it("adds, persists, and reloads subscribers", () => {
    const registry = new TelegramSubscriberRegistry(path, "[t]: ", "111");
    expect(registry.add("222")).toBe(true);
    expect(registry.add("222")).toBe(false); // idempotent

    const reloaded = new TelegramSubscriberRegistry(path, "[t]: ", "111");
    expect(reloaded.has("111")).toBe(true);
    expect(reloaded.has("222")).toBe(true);
  });

  it("removes subscribers", () => {
    const registry = new TelegramSubscriberRegistry(path, "[t]: ", "111");
    registry.add("222");
    expect(registry.remove("222")).toBe(true);
    expect(registry.remove("222")).toBe(false);
    expect(registry.has("222")).toBe(false);

    const reloaded = new TelegramSubscriberRegistry(path, "[t]: ", "111");
    expect(reloaded.has("222")).toBe(false);
  });

  it("tolerates a malformed subscribers file", () => {
    writeFileSync(path, "not json at all");
    const registry = new TelegramSubscriberRegistry(path, "[t]: ", "111");
    expect(registry.all()).toEqual(["111"]);
  });

  it("works in-memory when no path is configured", () => {
    const registry = new TelegramSubscriberRegistry(undefined, "[t]: ", "111");
    registry.add("222");
    expect(registry.has("222")).toBe(true);
  });
});

describe("parseTelegramCommand", () => {
  it("parses command and argument", () => {
    expect(parseTelegramCommand("/start mysecret")).toEqual({ command: "/start", arg: "mysecret" });
  });

  it("lowercases and strips bot usernames", () => {
    expect(parseTelegramCommand("/Start@WickedMevBot")).toEqual({ command: "/start", arg: "" });
  });

  it("returns undefined for non-commands and empty text", () => {
    expect(parseTelegramCommand("hello there")).toBeUndefined();
    expect(parseTelegramCommand(undefined)).toBeUndefined();
    expect(parseTelegramCommand("  ")).toBeUndefined();
  });
});

describe("TelegramNotifier command handling", () => {
  let dir: string;
  let path: string;
  const sent: { chatId: string; text: string }[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tg-cmds-"));
    path = join(dir, "subscribers.json");
    sent.length = 0;
    nock.cleanAll();
    nock("https://api.telegram.org")
      .post(/\/botTOKEN\/sendMessage/)
      .reply(200, (_uri, body) => {
        const b = body as { chat_id: string; text: string };
        sent.push({ chatId: String(b.chat_id), text: b.text });
        return { ok: true };
      })
      .persist();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeNotifier = () => {
    const registry = new TelegramSubscriberRegistry(path, "[t]: ", "owner");
    const notifier = new TelegramNotifier({
      botToken: "TOKEN",
      chatId: "owner",
      logTag: "[t]: ",
      registry,
    });
    return { registry, notifier };
  };

  const handle = async (
    notifier: TelegramNotifier,
    chatId: number,
    text: string,
    inputs: { secret?: string; metricsPath?: string } = { secret: "s3cret" },
  ) => {
    await (
      notifier as unknown as {
        handleUpdate: (u: unknown, i: unknown) => Promise<void>;
      }
    ).handleUpdate({ update_id: 1, message: { chat: { id: chatId }, text } }, inputs);
  };

  it("rejects /start with a bad secret and adds nothing", async () => {
    const { registry, notifier } = makeNotifier();
    await handle(notifier, 222, "/start wrong");
    expect(registry.has("222")).toBe(false);
    expect(sent[0]?.text).toContain("Invalid");
  });

  it("rejects /start entirely when no secret is configured", async () => {
    const { registry, notifier } = makeNotifier();
    await handle(notifier, 222, "/start", {});
    expect(registry.has("222")).toBe(false);
  });

  it("subscribes on /start with the correct secret", async () => {
    const { registry, notifier } = makeNotifier();
    await handle(notifier, 222, "/start s3cret");
    expect(registry.has("222")).toBe(true);
    expect(sent[0]?.text).toContain("Subscribed");
    // Persisted.
    expect(
      (JSON.parse(readFileSync(path, "utf8")) as { subscribers: string[] }).subscribers,
    ).toContain("222");
  });

  it("is idempotent on repeated /start", async () => {
    const { registry, notifier } = makeNotifier();
    await handle(notifier, 222, "/start s3cret");
    await handle(notifier, 222, "/start s3cret");
    expect(registry.all().filter((c) => c === "222")).toHaveLength(1);
    expect(sent[1]?.text).toContain("already subscribed");
  });

  it("unsubscribes on /stop", async () => {
    const { registry, notifier } = makeNotifier();
    await handle(notifier, 222, "/start s3cret");
    await handle(notifier, 222, "/stop");
    expect(registry.has("222")).toBe(false);
    expect(sent[1]?.text).toContain("Unsubscribed");
  });

  it("refuses /status for non-subscribers and serves it for subscribers", async () => {
    const { notifier } = makeNotifier();
    await handle(notifier, 222, "/status");
    expect(sent[0]?.text).toContain("Not subscribed");

    await handle(notifier, 222, "/start s3cret");
    await handle(notifier, 222, "/status");
    const last = sent[sent.length - 1]!;
    expect(last.text).toContain("Daily Liquidation Report");
  });

  it("ignores non-command messages", async () => {
    const { notifier } = makeNotifier();
    await handle(notifier, 222, "hello bot");
    expect(sent).toHaveLength(0);
  });
});

describe("execution alerts", () => {
  let dir: string;
  let path: string;
  const sent: { chatId: string; text: string }[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tg-alerts-"));
    path = join(dir, "subscribers.json");
    sent.length = 0;
    nock.cleanAll();
    nock("https://api.telegram.org")
      .post(/\/botTOKEN\/sendMessage/)
      .reply(200, (_uri, body) => {
        const b = body as { chat_id: string; text: string };
        sent.push({ chatId: String(b.chat_id), text: b.text });
        return { ok: true };
      })
      .persist();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeNotifier = () =>
    new TelegramNotifier({
      botToken: "TOKEN",
      chatId: "owner",
      logTag: "[t]: ",
      registry: new TelegramSubscriberRegistry(path, "[t]: ", "owner"),
    });

  it("renders the executed alert with gross→net profit, tx, and latency", async () => {
    const notifier = makeNotifier();
    await notifier.sendTradeAlert({
      kind: "liquidation",
      outcome: "executed",
      user: "0xabc123",
      marketId: "0xmkt",
      profitUsd: 8.25,
      gasUsd: 0.05,
      txHash: "0xtxhash",
      latencyMs: 165,
    });
    expect(sent[0]?.text).toContain("🎯 LIQUIDATION EXECUTED");
    expect(sent[0]?.text).toContain("Profit: $8.30 → net $8.25");
    expect(sent[0]?.text).toContain("Gas: $0.0500");
    expect(sent[0]?.text).toContain("Tx: 0xtxhash");
    expect(sent[0]?.text).toContain("Latency: 165ms");
  });

  it("renders the failed alert with the revert error", async () => {
    const notifier = makeNotifier();
    await notifier.sendTradeAlert({
      kind: "liquidation",
      outcome: "failed",
      user: "0xabc123",
      marketId: "0xmkt",
      error: "nonce too low",
    });
    expect(sent[0]?.text).toContain("❌ LIQUIDATION FAILED");
    expect(sent[0]?.text).toContain("Error: nonce too low");
    expect(sent[0]?.text).not.toContain("Latency:");
  });

  it("renders the LOST alert with optional fields only when present", async () => {
    const notifier = makeNotifier();
    await notifier.sendLostAlert({
      borrower: "0xdef5678",
      marketId: "0xmkt",
      winnerTx: "0xwin",
      debtDisplay: "$4,200",
      ourAttempt: "sim_failed (12s ago)",
    });
    expect(sent[0]?.text).toContain("❌ LIQUIDATION LOST");
    expect(sent[0]?.text).toContain("Winner tx: 0xwin");
    expect(sent[0]?.text).toContain("Debt: $4,200");
    expect(sent[0]?.text).toContain("Our attempt: sim_failed (12s ago)");

    await notifier.sendLostAlert({
      borrower: "0xdef5678",
      marketId: "0xmkt",
      winnerTx: "0xwin2",
    });
    expect(sent[1]?.text).not.toContain("Debt:");
    expect(sent[1]?.text).not.toContain("Our attempt:");
  });
});
