import { chainConfigs } from "@morpho-blue-liquidation-bot/config";
import dotenv from "dotenv";
import { createWalletClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { deploy } from "./utils/deploy-executor.js";

// Robinhood Chain (4663)
const CHAIN_ID = 4663;

async function run() {
  dotenv.config();

  const config = chainConfigs[CHAIN_ID];
  if (!config) {
    throw new Error(`No config found for chainId ${CHAIN_ID}`);
  }

  const chain = config.chain;
  const rpcUrl = process.env[`RPC_URL_${CHAIN_ID}`] ?? chain.rpcUrls.default.http[0];
  const privateKey = process.env[`LIQUIDATION_PRIVATE_KEY_${CHAIN_ID}`];

  if (!rpcUrl) {
    throw new Error(`RPC_URL_${CHAIN_ID} is not set`);
  }
  if (!privateKey) {
    throw new Error(`LIQUIDATION_PRIVATE_KEY_${CHAIN_ID} is not set`);
  }

  const client = createWalletClient({
    chain,
    transport: http(rpcUrl),
    account: privateKeyToAccount(privateKey as Hex),
  });

  await deploy(client, privateKeyToAccount(privateKey as Hex).address);
}

void run();
