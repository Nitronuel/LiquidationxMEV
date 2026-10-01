import {
  MARKETS_FETCHING_COOLDOWN_PERIOD,
  POSITION_LIQUIDATION_COOLDOWN_ENABLED,
  POSITION_LIQUIDATION_COOLDOWN_PERIOD,
  ALWAYS_REALIZE_BAD_DEBT,
  getChainAddressesWithOverrides,
  type ChainConfig,
} from "@morpho-blue-liquidation-bot/config";
import type { DataProvider } from "@morpho-blue-liquidation-bot/data-providers";
import { createLiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import { createPricer } from "@morpho-blue-liquidation-bot/pricers";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  fallback,
  http,
  webSocket,
  Hex,
  parseUnits,
  type Account,
  type Address,
  type Chain,
  type Client,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readContract, watchBlocks } from "viem/actions";

import { LiquidationBot, type LiquidationBotInputs } from "./bot";
import { liveness } from "./health";
import { startLogTrigger, startSequencerFeedTrigger, ThrottledTrigger } from "./triggers";
import {
  MarketsFetchingCooldownMechanism,
  PositionLiquidationCooldownMechanism,
} from "./utils/cooldownMechanisms";
import { LiquidationObserver } from "./utils/liquidationObserver";
import { MetricsLogger } from "./utils/metrics";
import { TelegramNotifier } from "./utils/telegram";
import { TelegramSubscriberRegistry } from "./utils/telegramSubscribers";

/** How often market-oracle addresses are refreshed for the log trigger (ms). */
const WATCH_ADDRESSES_REFRESH_MS = 5 * 60_000;
/** Default minimum spacing between evaluations initiated by the same trigger source. */
const DEFAULT_TRIGGER_MIN_INTERVAL_MS = 1_000;
/** Default interval for safety-net full evaluations of all candidates. */
const DEFAULT_HOT_PATH_POLL_MS = 30_000;

export const launchBot = (config: ChainConfig, dataProvider: DataProvider) => {
  const logTag = `[${config.chain.name} client]: `;
  const dryRun = process.env.DRY_RUN === "true";
  console.log(
    `${logTag}Starting up${dryRun ? " 🧪 (DRY-RUN: no transactions will be broadcast)" : ""}`,
  );

  // HTTP transports in strict priority order (rank disabled so the primary is
  // always preferred and fallbacks are only used on failure). A single-URL
  // setup degrades to a plain http transport.
  const fallbackUrls = config.fallbackRpcUrls ?? [];
  const httpTransport =
    fallbackUrls.length > 0
      ? fallback([http(config.rpcUrl), ...fallbackUrls.map((url) => http(url))], { rank: false })
      : http(config.rpcUrl);

  const client = createWalletClient({
    chain: config.chain,
    transport: httpTransport,
    account: privateKeyToAccount(config.liquidationPrivateKey),
  });

  // When a WebSocket RPC URL is configured, watch blocks via push subscription
  // (`poll: false`) so new heads arrive within milliseconds of block propagation
  // instead of on the HTTP polling interval. Signing/broadcasting stays on HTTP.
  const wsWatchEnabled = Boolean(config.wsRpcUrl);
  const watchClient: Client<
    Transport<"http" | "webSocket" | "fallback">,
    Chain,
    Account
  > = wsWatchEnabled
    ? createPublicClient({
        chain: config.chain,
        transport: webSocket(config.wsRpcUrl, {
          reconnect: { delay: config.watchBlocksRetryDelayMs ?? 5_000 },
        }),
      })
    : client;

  // LIQUIDITY VENUES
  const liquidityVenues = config.liquidityVenues.map((liquidityVenueName) =>
    createLiquidityVenue(liquidityVenueName),
  );

  // PRICERS
  const pricers = config.pricers
    ? config.pricers.map((pricerName) => createPricer(pricerName))
    : undefined;

  // FlASHBOTS

  let flashbotAccount = undefined;
  if (config.useFlashbots) {
    const flashbotsPrivateKey = process.env.FLASHBOTS_PRIVATE_KEY;

    if (flashbotsPrivateKey === undefined) {
      throw new Error(`${logTag} FLASHBOTS_PRIVATE_KEY is not set`);
    }

    flashbotAccount = privateKeyToAccount(process.env.FLASHBOTS_PRIVATE_KEY as Hex);
  }

  let positionLiquidationCooldownMechanism = undefined;
  if (POSITION_LIQUIDATION_COOLDOWN_ENABLED) {
    positionLiquidationCooldownMechanism = new PositionLiquidationCooldownMechanism(
      POSITION_LIQUIDATION_COOLDOWN_PERIOD,
    );
  }

  const marketsFetchingCooldownMechanism = new MarketsFetchingCooldownMechanism(
    MARKETS_FETCHING_COOLDOWN_PERIOD,
  );

  // TELEGRAM NOTIFIER (optional — trade alerts + UTC-midnight daily report,
  // broadcast to subscribers; /start <secret> /stop /status command polling)
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  let notifier: TelegramNotifier | undefined;
  if (telegramBotToken && telegramChatId) {
    const registry = new TelegramSubscriberRegistry(
      process.env.TELEGRAM_SUBSCRIBERS_PATH,
      logTag,
      telegramChatId,
    );
    notifier = new TelegramNotifier({
      botToken: telegramBotToken,
      chatId: telegramChatId,
      logTag,
      registry,
    });
    notifier.startCommandPolling({
      secret: process.env.TELEGRAM_SHARED_SECRET,
      metricsPath: process.env.METRICS_PATH,
      getRadarSnapshot: () => bot.getRadarSnapshot(),
      resolveTokenDecimals: async (token) => {
        try {
          return await readContract(client, {
            address: token as Address,
            abi: erc20Abi,
            functionName: "decimals",
          });
        } catch {
          return undefined;
        }
      },
    });
    console.log(`${logTag}📣 Telegram notifications enabled`);
  }

  const inputs: LiquidationBotInputs = {
    logTag,
    chainId: config.chainId,
    client,
    wNative: config.wNative,
    vaultWhitelist: config.vaultWhitelist,
    additionalMarketsWhitelist: config.additionalMarketsWhitelist,
    executorAddress: config.executorAddress,
    treasuryAddress: config.treasuryAddress ?? client.account.address,
    dataProvider,
    liquidityVenues,
    pricers,
    marketsFetchingCooldownMechanism,
    positionLiquidationCooldownMechanism,
    flashbotAccount,
    alwaysRealizeBadDebt: ALWAYS_REALIZE_BAD_DEBT,
    useFlashLoans: config.useFlashLoans,
    watchAllBorrowMarkets: config.watchAllBorrowMarkets,
    minProfitUsdFloor: config.minProfitUsdFloor,
    maxDailyLosses: config.maxDailyLosses,
    simFailureBackoffMs: config.simFailureBackoffMs,
    skippedUnprofitableBackoffMs: config.skippedUnprofitableBackoffMs,
    metricsPath: process.env.METRICS_PATH,
    notifier,
    dryRun,
    preLiquidationHealthFactorThreshold:
      config.preLiquidationHealthFactorThresholdBps !== undefined
        ? parseUnits(config.preLiquidationHealthFactorThresholdBps.toString(), 14)
        : undefined,
  };

  const bot = new LiquidationBot(inputs);

  // Expose per-chain cycle liveness on the /health endpoint (200 ok / 503 degraded).
  liveness.register(config.chainId, config.chain.name);

  // Public read-only client for routine evaluations (safety polls, feed-tick
  // runs) — saves provider compute units. Simulation/broadcast stay on the
  // Alchemy wallet client. Same fallback chain as the wallet client.
  const publicReadUrl = config.chain.rpcUrls.default.http[0];
  const publicReadClient: Client<Transport<"http">, Chain, Account> | undefined =
    publicReadUrl && publicReadUrl !== config.rpcUrl
      ? ((fallbackUrls.length > 0
          ? createPublicClient({
              chain: config.chain,
              transport: fallback([http(publicReadUrl), ...fallbackUrls.map((url) => http(url))], {
                rank: false,
              }),
            })
          : createPublicClient({ chain: config.chain, transport: http(publicReadUrl) })) as Client<
          Transport<"http">,
          Chain,
          Account
        >)
      : undefined;

  const triggerMinIntervalMs = config.triggerMinIntervalMs ?? DEFAULT_TRIGGER_MIN_INTERVAL_MS;
  const hotPathPollMs = config.hotPathPollMs ?? DEFAULT_HOT_PATH_POLL_MS;
  const feedConfigured = Boolean(config.sequencerFeedUrl);

  const blockInterval = config.blockInterval ?? 1;
  let count = 0;
  let runInProgress = false;
  let hasQueued = false;
  let queuedClient: Client<Transport, Chain> | undefined;

  const executeRun = (readClient?: Client<Transport, Chain>) => {
    runInProgress = true;
    liveness.recordCycleStart(config.chainId);
    let runError = false;
    bot
      .run(readClient)
      .catch((e: unknown) => {
        console.error(`${logTag} uncaught error in bot.run():`, e);
        runError = true;
      })
      .finally(() => {
        runInProgress = false;
        liveness.recordCycleEnd(config.chainId, runError);
        // Queue-latest semantics: a trigger arriving mid-run schedules exactly
        // one follow-up run with fresh state, instead of being dropped.
        if (hasQueued) {
          hasQueued = false;
          const queued = queuedClient;
          queuedClient = undefined;
          executeRun(queued);
        }
      });
  };

  const scheduleRun = (readClient?: Client<Transport, Chain>) => {
    if (runInProgress) {
      hasQueued = true;
      queuedClient = readClient;
      return;
    }
    executeRun(readClient);
  };

  const startWatching = () => {
    let unwatch = () => {};

    unwatch = watchBlocks(watchClient, {
      onBlock: () => {
        if (count % blockInterval === 0) scheduleRun();
        count++;
      },
      onError: (error) => {
        // Tear down the current watcher before restarting. viem dedupes
        // watchers by observer id, so restarting without unwatching turns
        // every disconnect into an ever-growing listener leak, each of which
        // runs a full bot cycle per block and eventually OOMs the process.
        unwatch();
        const retryDelay = config.watchBlocksRetryDelayMs ?? 5_000;
        console.error(`${logTag} watchBlocks error, restarting watcher in ${retryDelay}ms:`, error);
        setTimeout(startWatching, retryDelay);
      },
      // viem's types narrow `poll` to `true` for HTTP transports; the runtime
      // value is `false` exactly when the transport is a WebSocket subscription.
      poll: !wsWatchEnabled as true,
      pollingInterval: 500,
    });
  };

  // BLOCK SOURCE — when the sequencer feed is configured it replaces newHeads
  // entirely: feed frames arrive before blocks propagate to any RPC, cost zero
  // compute units, and every state change we care about (oracles, Morpho) also
  // reaches us via the log subscription below.
  if (feedConfigured) {
    console.log(
      `${logTag}⏱️ block source: sequencer feed (newHeads watcher disabled — saves ~13–35M CU/day)`,
    );
  } else {
    startWatching();
  }

  // TRIGGER LANES — sources that force an evaluation ahead of the safety poll:
  // 1. Sequencer feed ticks → evaluated on the public RPC (free).
  // 2. Log events from market oracles + Morpho Blue → evaluated on Alchemy
  //    (price updates and borrow-state changes can push a position below
  //    threshold mid-block; fastest link reserved for these).
  // 3. Safety-net poll on a slow interval → public RPC, closes reconnect gaps.
  const feedTrigger = new ThrottledTrigger(triggerMinIntervalMs, () => {
    scheduleRun(publicReadClient);
  });
  const eventTrigger = new ThrottledTrigger(triggerMinIntervalMs, () => {
    scheduleRun();
  });

  if (config.sequencerFeedUrl) {
    startSequencerFeedTrigger(
      config.sequencerFeedUrl,
      () => {
        feedTrigger.fire();
      },
      logTag,
      {
        retryDelayMs: config.watchBlocksRetryDelayMs ?? 5_000,
      },
    );
  }

  if (wsWatchEnabled) {
    let watchedAddresses: Address[] = [];

    const morphoAddress = getChainAddressesWithOverrides(config.chainId).morpho;
    const refreshWatchAddresses = async (resubscribe: boolean) => {
      try {
        const oracles = (await dataProvider.fetchWatchAddresses?.(client)) ?? [];
        const addresses = [...new Set([morphoAddress, ...oracles])];
        const changed =
          addresses.length !== watchedAddresses.length ||
          addresses.some((a) => !watchedAddresses.includes(a));
        watchedAddresses = addresses;
        if (resubscribe && changed) logTrigger?.refresh();
      } catch (error) {
        console.error(`${logTag}failed to refresh watch addresses:`, error);
      }
    };

    const logTrigger = startLogTrigger(
      watchClient,
      () => watchedAddresses,
      () => {
        eventTrigger.fire();
      },
      logTag,
      { retryDelayMs: config.watchBlocksRetryDelayMs ?? 5_000 },
    );

    void refreshWatchAddresses(false);
    setInterval(() => void refreshWatchAddresses(true), WATCH_ADDRESSES_REFRESH_MS);

    // COMPETITOR WATCH — record every on-chain Liquidate event (who, what, gas)
    // for race-loss detection in the daily report.
    if (morphoAddress) {
      new LiquidationObserver({
        watchClient,
        morphoAddress,
        executorAddress: config.executorAddress,
        wNative: config.wNative,
        pricers,
        metrics: new MetricsLogger(process.env.METRICS_PATH, logTag),
        radarEntries: () => bot.getRadarEntries(),
        notifier,
        getRadarSnapshot: () => bot.getRadarSnapshot(),
        resolveTokenDecimals: async (token) => {
          try {
            return await readContract(client, {
              address: token as Address,
              abi: erc20Abi,
              functionName: "decimals",
            });
          } catch {
            return undefined;
          }
        },
        getRecentAttempt: (user, marketId) => bot.getRecentAttempt(user, marketId),
        logTag,
      }).start();
      console.log(`${logTag}🕵️ competitor liquidation watch enabled`);
    }
  }

  setInterval(() => {
    scheduleRun(publicReadClient);
  }, hotPathPollMs);
  console.log(
    `${logTag}🧮 CU-efficient mode: safety poll every ${hotPathPollMs / 1000}s on ${publicReadClient ? "public RPC" : "primary RPC"}; trigger lanes: ${[
      feedConfigured ? "sequencer-feed" : null,
      wsWatchEnabled ? "oracle/Morpho logs" : null,
    ]
      .filter(Boolean)
      .join(" + ")}`,
  );
};
