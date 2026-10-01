import { afterEach, describe, expect, it } from "vitest";

import { robinhood } from "../src/chains";
import { getSecrets } from "../src/index";

const ENV: Record<string, string> = {
  RPC_URL_4663: "https://primary.example/v2",
  RPC_URL_4663_FALLBACKS: " https://fallback-a.example , https://fallback-b.example ,,",
  EXECUTOR_ADDRESS_4663: "0x0000000000000000000000000000000000000001",
  LIQUIDATION_PRIVATE_KEY_4663:
    "0x0000000000000000000000000000000000000000000000000000000000000001",
};

describe("getSecrets RPC fallbacks", () => {
  afterEach(() => {
    for (const key of Object.keys(ENV)) delete process.env[key];
  });

  it("parses RPC_URL_<id>_FALLBACKS into a trimmed, de-duplicated list", () => {
    for (const [key, value] of Object.entries(ENV)) process.env[key] = value;

    const { rpcUrl, fallbackRpcUrls } = getSecrets(4663);
    expect(rpcUrl).toBe("https://primary.example/v2");
    expect(fallbackRpcUrls).toEqual([
      "https://fallback-a.example",
      "https://fallback-b.example",
    ]);
  });

  it("never includes the primary URL in the fallback list", () => {
    for (const [key, value] of Object.entries(ENV)) process.env[key] = value;
    process.env.RPC_URL_4663_FALLBACKS = `${ENV.RPC_URL_4663} , https://fallback-a.example`;

    const { fallbackRpcUrls } = getSecrets(4663);
    expect(fallbackRpcUrls).toEqual(["https://fallback-a.example"]);
  });

  it("uses the chain's remaining built-in URLs when no env fallbacks are set", () => {
    process.env.RPC_URL_4663 = robinhood.rpcUrls.default.http[0] as string;
    process.env.EXECUTOR_ADDRESS_4663 = ENV.EXECUTOR_ADDRESS_4663 as string;
    process.env.LIQUIDATION_PRIVATE_KEY_4663 = ENV.LIQUIDATION_PRIVATE_KEY_4663 as string;
    delete process.env.RPC_URL_4663_FALLBACKS;

    const { fallbackRpcUrls } = getSecrets(4663);
    // Robinhood ships a single built-in HTTP URL → nothing extra to add.
    expect(fallbackRpcUrls).toEqual([]);
  });
});
