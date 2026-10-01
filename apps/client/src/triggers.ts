import type { Address, Chain, Client, Transport } from "viem";
import { watchEvent } from "viem/actions";

/**
 * Coalesces high-frequency trigger sources (sequencer feed frames, on-chain events)
 * into a bounded rate of callbacks: fires immediately when idle, then at most once
 * per `minIntervalMs`, collapsing bursts into a single trailing callback.
 */
export class ThrottledTrigger {
  private readonly minIntervalMs: number;
  private readonly onFire: () => void;
  private lastFiredAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(minIntervalMs: number, onFire: () => void) {
    this.minIntervalMs = minIntervalMs;
    this.onFire = onFire;
  }

  fire() {
    if (this.timer !== undefined) return;

    const elapsed = Date.now() - this.lastFiredAt;
    if (elapsed >= this.minIntervalMs) {
      this.lastFiredAt = Date.now();
      this.onFire();
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.lastFiredAt = Date.now();
      this.onFire();
    }, this.minIntervalMs - elapsed);
  }

  stop() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

interface SequencerFeedHandle {
  stop: () => void;
}

/** Minimal structural type for Node's built-in WebSocket client (global since Node 22). */
interface FeedWebSocket {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close: () => void;
}

/**
 * Connects to an Arbitrum Nitro sequencer feed (`wss://feed.<chain>`) and calls
 * `onActivity` for every received frame. The feed announces sequenced messages
 * before any RPC/indexer observes the resulting block, making it the earliest
 * available activity signal. Frames are not parsed further — they are only used
 * as ticks; the caller is responsible for coalescing via `ThrottledTrigger`.
 */
export const startSequencerFeedTrigger = (
  feedUrl: string,
  onActivity: () => void,
  logTag: string,
  options?: { retryDelayMs?: number },
): SequencerFeedHandle => {
  const retryDelayMs = options?.retryDelayMs ?? 5_000;
  const WSConstructor = (globalThis as unknown as { WebSocket: new (url: string) => FeedWebSocket })
    .WebSocket;
  // The global WebSocket client exists only on Node >= 22 (CI, local dev and the
  // node:22 image). On older runtimes degrade to a single warning instead of a
  // crash-reconnect loop every 30s — the block/HTTP triggers cover the bot.
  if (typeof WSConstructor !== "function") {
    console.error(
      `${logTag}sequencer feed trigger unavailable: global WebSocket client not found ` +
        `(requires Node >= 22) — falling back to block/log triggers only`,
    );
    return { stop: () => {} };
  }
  let ws: FeedWebSocket | undefined;
  let stopped = false;
  let attempts = 0;
  // `onerror` and `onclose` both fire for a single dropped connection; without
  // this guard each drop schedules two reconnects, and every subsequent drop
  // doubles the number of live sockets until the process melts down.
  let reconnectScheduled = false;

  const connect = () => {
    if (stopped) return;
    reconnectScheduled = false;
    try {
      ws = new WSConstructor(feedUrl);
    } catch (error) {
      console.error(`${logTag}sequencer feed connect failed:`, error);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      attempts = 0;
      console.log(`${logTag}sequencer feed connected (${feedUrl})`);
    };

    ws.onmessage = () => {
      onActivity();
    };

    ws.onclose = () => {
      scheduleReconnect();
    };
    // Errors are always followed by a close event — log only, never reconnect
    // from here, or the close handler duplicates the attempt.
    ws.onerror = () => {};
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectScheduled) return;
    reconnectScheduled = true;
    attempts += 1;
    const delay = Math.min(30_000, retryDelayMs * 2 ** Math.min(attempts, 5));
    console.error(`${logTag}sequencer feed disconnected, reconnecting in ${delay}ms`);
    setTimeout(connect, delay);
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      ws?.close();
    },
  };
};

interface LogTriggerHandle {
  stop: () => void;
  /** Re-subscribes (e.g. after the watched address set changes). */
  refresh: () => void;
}

/**
 * Subscribes to logs emitted by the given addresses (market oracles, Morpho Blue
 * singleton) over the WebSocket RPC and calls `onLogs` for every batch. Any event
 * touching a market's oracle or the Morpho contract can change a position's health
 * factor, so each batch is treated as an immediate evaluation tick.
 */
export const startLogTrigger = (
  watchClient: Client<Transport<"http" | "webSocket" | "fallback">, Chain>,
  getAddresses: () => Address[],
  onLogs: () => void,
  logTag: string,
  options?: { retryDelayMs?: number },
): LogTriggerHandle => {
  const retryDelayMs = options?.retryDelayMs ?? 5_000;
  let unwatch = () => {};

  const subscribe = () => {
    unwatch();
    const addresses = getAddresses();
    if (addresses.length === 0) return;

    unwatch = watchEvent(watchClient, {
      address: addresses,
      onLogs: () => {
        onLogs();
      },
      onError: (error) => {
        // viem dedupes watchers by observer id — always tear down before
        // re-subscribing to avoid listener leaks (see startWatching note).
        unwatch();
        console.error(`${logTag}log trigger error, re-subscribing in ${retryDelayMs}ms:`, error);
        setTimeout(subscribe, retryDelayMs);
      },
    });
  };

  subscribe();

  return {
    stop: () => {
      unwatch();
    },
    refresh: subscribe,
  };
};
