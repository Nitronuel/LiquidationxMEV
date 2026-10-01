FROM node:22-alpine

# Set working directory
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/config/package.json ./apps/config/
COPY apps/client/package.json ./apps/client/

# Install dependencies (this layer will be cached unless package files change)
# Note: node_modules will be installed for Linux platform inside the container
RUN pnpm install --frozen-lockfile

# Copy the rest of the source code
COPY . .

# Railway injects secrets as runtime environment variables:
# - RPC_URL_<chainId> and RPC_URL_<chainId>_FALLBACKS (optional backups)
# - WS_RPC_URL_<chainId> (optional WebSocket endpoint)
# - EXECUTOR_ADDRESS_<chainId>
# - LIQUIDATION_PRIVATE_KEY (shared across chains)
# Optional toggles: DRY_RUN, METRICS_PATH, HEALTH_PORT, FLASHBOTS_PRIVATE_KEY,
# LIFI_API_KEY, ZERO_EX_API_KEY, ONE_INCH_SWAP_API_KEY, TELEGRAM_*.

# Chains the bot will try to run (built into the .env generated at start).
# Must match apps/config/src/config.ts chainConfigs; override at deploy time
# to run a subset. Any chain whose RPC_URL is not injected is skipped.
ENV CHAIN_IDS="1 130 8453 747474 999 143 4217 4663"

# Create cache directory and declare it as a volume to persist between runs
RUN mkdir -p .cache
VOLUME ["/app/.cache"]

# Container health: /health returns 200 while every registered bot completes
# evaluation cycles, 503 once a chain goes silent (see apps/client/src/health.ts).
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Build the .env file dynamically at container start, then launch.
# Per-chain vars are only emitted when injected (empty entries would otherwise
# shadow the chain's built-in default RPC); optional globals only when set.
CMD ["sh", "-lc", "{ \
  for CHAIN in $CHAIN_IDS; do \
    if [ -n \"$(printenv RPC_URL_$CHAIN)\" ]; then \
      echo \"RPC_URL_${CHAIN}=$(printenv RPC_URL_$CHAIN)\"; \
      if [ -n \"$(printenv RPC_URL_${CHAIN}_FALLBACKS)\" ]; then \
        echo \"RPC_URL_${CHAIN}_FALLBACKS=$(printenv RPC_URL_${CHAIN}_FALLBACKS)\"; \
      fi; \
      if [ -n \"$(printenv WS_RPC_URL_$CHAIN)\" ]; then \
        echo \"WS_RPC_URL_${CHAIN}=$(printenv WS_RPC_URL_$CHAIN)\"; \
      fi; \
      echo \"EXECUTOR_ADDRESS_${CHAIN}=$(printenv EXECUTOR_ADDRESS_$CHAIN)\"; \
      echo \"LIQUIDATION_PRIVATE_KEY_${CHAIN}=$(printenv LIQUIDATION_PRIVATE_KEY)\"; \
    fi; \
  done; \
  if [ -n \"$(printenv DRY_RUN)\" ]; then echo \"DRY_RUN=$(printenv DRY_RUN)\"; fi; \
  if [ -n \"$(printenv METRICS_PATH)\" ]; then echo \"METRICS_PATH=$(printenv METRICS_PATH)\"; fi; \
  if [ -n \"$(printenv HEALTH_PORT)\" ]; then echo \"HEALTH_PORT=$(printenv HEALTH_PORT)\"; fi; \
  if [ -n \"$(printenv FLASHBOTS_PRIVATE_KEY)\" ]; then echo \"FLASHBOTS_PRIVATE_KEY=$(printenv FLASHBOTS_PRIVATE_KEY)\"; fi; \
  if [ -n \"$(printenv LIFI_API_KEY)\" ]; then echo \"LIFI_API_KEY=$(printenv LIFI_API_KEY)\"; fi; \
  if [ -n \"$(printenv ZERO_EX_API_KEY)\" ]; then echo \"ZERO_EX_API_KEY=$(printenv ZERO_EX_API_KEY)\"; fi; \
  if [ -n \"$(printenv ONE_INCH_SWAP_API_KEY)\" ]; then echo \"ONE_INCH_SWAP_API_KEY=$(printenv ONE_INCH_SWAP_API_KEY)\"; fi; \
  if [ -n \"$(printenv TELEGRAM_BOT_TOKEN)\" ]; then echo \"TELEGRAM_BOT_TOKEN=$(printenv TELEGRAM_BOT_TOKEN)\"; fi; \
  if [ -n \"$(printenv TELEGRAM_CHAT_ID)\" ]; then echo \"TELEGRAM_CHAT_ID=$(printenv TELEGRAM_CHAT_ID)\"; fi; \
  if [ -n \"$(printenv TELEGRAM_SHARED_SECRET)\" ]; then echo \"TELEGRAM_SHARED_SECRET=$(printenv TELEGRAM_SHARED_SECRET)\"; fi; \
  if [ -n \"$(printenv TELEGRAM_SUBSCRIBERS_PATH)\" ]; then echo \"TELEGRAM_SUBSCRIBERS_PATH=$(printenv TELEGRAM_SUBSCRIBERS_PATH)\"; fi; \
} > .env && pnpm run liquidate"]
