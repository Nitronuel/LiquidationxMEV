import { arbitrum, base, katana, mainnet, tempo, unichain, worldchain } from "viem/chains";

import { hyperevm, monad, robinhood } from "./chains";
import type { Config } from "./types";

/// Bad debt realization

export const ALWAYS_REALIZE_BAD_DEBT = false; // true if you want to always realize bad debt

/// Flash loans

/// Morpho Blue flash loan fee, in basis points. Hardcoded to 0.04% on the protocol.
export const FLASHLOAN_FEE_BPS = 4;

/// Cooldown mechanisms

export const MARKETS_FETCHING_COOLDOWN_PERIOD = 60 * 60 * 24; // 24 hours (1 day)
export const POSITION_LIQUIDATION_COOLDOWN_ENABLED = true; // true if you want to enable the cooldown mechanism
export const POSITION_LIQUIDATION_COOLDOWN_PERIOD = 60 * 60; // 1 hour

/// Chains configurations

export const chainConfigs: Record<number, Config> = {
  [mainnet.id]: {
    chain: mainnet,
    wNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: [
        "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB",
        "0x8eB67A509616cd6A7c1B3c8C21D48FF57df3d458",
      ],
      additionalMarketsWhitelist: [
        "0x1eda1b67414336cab3914316cb58339ddaef9e43f939af1fed162a989c98bc20",
        "0xff527fe9c6516f9d82a3d51422ccb031d123266e6e26d4c22c942a948c180a75",
      ],
      liquidityVenues: [
        "pendlePT",
        "midas",
        "1inch",
        "erc20Wrapper",
        "erc4626",
        "uniswapV3",
        "uniswapV4",
      ],
      pricers: ["defillama", "chainlink", "uniswapV3"],
      liquidationBufferBps: 50,
      useFlashbots: true,
      blockInterval: 2,
    },
  },
  [base.id]: {
    chain: base,
    wNative: "0x4200000000000000000000000000000000000006",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: ["0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183"],
      additionalMarketsWhitelist: [],
      liquidityVenues: [
        "pendlePT",
        "midas",
        "1inch",
        "erc20Wrapper",
        "erc4626",
        "uniswapV3",
        "uniswapV4",
      ],
      pricers: ["defillama", "chainlink", "uniswapV3"],
      liquidationBufferBps: 50,
      useFlashbots: false,
      blockInterval: 10,
    },
  },
  [unichain.id]: {
    chain: unichain,
    wNative: "0x4200000000000000000000000000000000000006",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [],
      liquidityVenues: ["1inch", "erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4"],
      liquidationBufferBps: 50,
      useFlashbots: false,
      blockInterval: 5,
    },
  },
  [katana.id]: {
    chain: katana,
    wNative: "0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [],
      liquidityVenues: ["erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4"],
      liquidationBufferBps: 50,
      useFlashbots: false,
      blockInterval: 5,
    },
  },
  [arbitrum.id]: {
    chain: arbitrum,
    wNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [],
      liquidityVenues: ["pendlePT", "1inch", "erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4"],
      liquidationBufferBps: 50,
      useFlashbots: false,
    },
  },
  [worldchain.id]: {
    chain: worldchain,
    wNative: "0x4200000000000000000000000000000000000006",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: [
        "0xb1E80387EbE53Ff75a89736097D34dC8D9E9045B", // Re7 USDC
        "0x348831b46876d3dF2Db98BdEc5E3B4083329Ab9f", // Re7 WLD
        "0x0Db7E405278c2674F462aC9D9eb8b8346D1c1571", // Re7 WETH
        "0xBC8C37467c5Df9D50B42294B8628c25888BECF61", // Re7 WBTC
      ],
      additionalMarketsWhitelist: [],
      liquidityVenues: ["erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4"],
      liquidationBufferBps: 50,
      useFlashbots: false,
      blockInterval: 5,
    },
  },
  [hyperevm.id]: {
    chain: hyperevm,
    wNative: "0x5555555555555555555555555555555555555555",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: [
        "0x8A862fD6c12f9ad34C9c2ff45AB2b6712e8CEa27", // Felix USDC
        "0xFc5126377F0efc0041C0969Ef9BA903Ce67d151e", // Felix USDT
        "0x2900ABd73631b2f60747e687095537B673c06A76", // Felix HYPE
      ],
      liquidityVenues: ["liquidSwap", "erc20Wrapper", "erc4626", "uniswapV3"],
      additionalMarketsWhitelist: [],
      liquidationBufferBps: 50,
      useFlashbots: false,
    },
  },
  [monad.id]: {
    chain: monad,
    wNative: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [],
      liquidityVenues: ["erc20Wrapper", "erc4626", "uniswapV3"],
      liquidationBufferBps: 50,
      useFlashbots: false,
      blockInterval: 10,
    },
  },
  [tempo.id]: {
    chain: tempo,
    wNative: "0x20C000000000000000000000b9537d11c60E8b50",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [],
      liquidityVenues: ["erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4"],
      liquidationBufferBps: 50,
      useFlashbots: false,
      blockInterval: 5,
    },
  },
  [robinhood.id]: {
    chain: robinhood,
    wNative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    options: {
      dataProvider: "morphoApi", // migrated from "hyperIndex" — see MIGRATION.md
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [
        "0x2338841846c6796db46f3c8639df54abcfd7198a22935a168932ea28073377ac",
        "0xc845da65a020ddca5f132efa8fea79676d8edfdea504226a4c01e7a9e34cddd6",
        "0x919a9b6b94dae7c86620eaf7a08e597aae8a4c3a9e9c7671771fbaf62b6b61c7",
        "0x0309c02dabf0be02682af1a2bde9a457f4df0f0b6bc889cde3f948e5315e4114",
        "0x039503b6308d6d818d181e626d3fbc667d6e68393c3d74332a6124cd2dd6e755",
        "0xaa586d26a6fe62d9c0f0948fede6e2130500ac7a655587447e2d4a37e6330589",
        "0x85da4c8b528f56ab5d0befcbc9fcf3fb06d51d3a5b399ffce6f8018ad14bc648",
        "0x66306c087add8907752320b309934abcc354d21626de8115c79df49d9c214edc",
        "0x2c3b7d9de42cea70ce6672ec8ad97f49638fc620e7cc0989361080ed5b89f044",
        "0x4979137c23c8fb519cd507adc290944c3c2120e8a3191547531fced28360e9c2",
        "0x7c820d6a09502d63be80bb8025ec479d29d7c06e70f8df65a92aaeed23a366e2",
        "0x0107cb59f42c4392806ecfccc8a8d57e993322801073706720bd6ee2822db13d",
        "0x01baec96478004fc7b74c8dfe38abef8d716fea59ffd481b6ec74db915d3bc80",
        "0x50bc39b5722fb5634c436d74c6787f3c125b879e7b73cf9e9ecc01bbb57b8e55",
        "0x315b99abb698487891243a84afd28a5ff56fe02143f203c03edd3f103936bf60",
        "0xafc86936af4f7edf083eb2550b8c42311b83c685982742b9271b309a58268855",
        "0x69400cfe81f2ae381b9a9f27076a4d637338379d999e9ffdfbde52f0876312ee",
        "0x7e6ebfdc58a893a5cddba0fba0483baf4fac2efece627ad50821dbe27d6f9738",
        "0x243ac165f79a75a0590d2e994ffa9e260b70292fd1ca134ace95f3640895b19f",
        "0x508b47fb12dbb8747644d4436aae65489b5f2819936adefc8a591323f64a5b01",
        "0xee04847a312224d551d2267bb5c2c2695777af5fd1f05347bdcca397e8f54336",
        "0xf6f3dbe0a19e948147e79e66502c6b05709d8dfde977fec7db1528fc8f0ebdfa",
        "0xb41b34c5989420ad080e79363a9cfe3e23bec7459fcd2d88029250da370288df",
        "0x4d2075836fd32183b10e5be1b383f6430de859df6d2bd5ec5b859970c4dd14e8",
        "0x1cfad1ebbc2be30c0d464c70c0057760a4c06308ead68bbee575471f1e35553d",
        "0x6b8a1f62d88d1cd1e8de609aef07cafc8226172ba703e57c52c3730350e61df1",
        "0x4edbd2f2f3b33bc5f80ab588def67fab8c10945fc99f855d80ff4bef2c4aa1f0",
        "0x74fece475178af9e06d31fb64f405046a305f8f0abc588782f596d6f261c1fbb",
        "0xda5584635e8b14ea18f674dbe4243365505910fefd8e3aa1ac9bfaac0eba74e8",
        "0xb5ba72c0d55c353fa37c0bea104eb117afb2f4934473bcb736d2218ae5686746",
        "0x9df4f54a2e46b35bd326cec97dbabc4203fa6c64a8e4182128f277adba8fefaf",
        "0x597227ca652ea5e8afb6e4801ecd766a4d6eb9b3b9fafa9127ba88a8b1f19629",
        "0x2ab6a14c9f68d4216dcb3b4e6ed607cf82f2e6badfa2bd5618d7f69d012d7fab",
        "0x01ab931866f6753d9246d451284c03d2b9cdf7f351120bc2e79045941777e7aa",
        "0xf4dff250826a86627545e5c6594b3b249db3ad2ec5eed56c02833d2a67acf445",
        "0x0909e699852eb642f6578f771a5350086f46076edfe4f77b97b5106799678d96",
        "0x42b79dfb20cf39e6bf2a1e87b936bf8aea7830bec2f11e28013991b87b626e2b",
        "0xe2a07cbdc2e9fc1d78618f8373a174ed426edc4c7ffc4c1ef8188414bb7bb7d0",
        "0x6c023a6871279d92be2d7bd8877f7b40f5926acbe05f1a80f7dba7199d81fbc0",
        "0xc23401d6f83231c83bcf4c67c7e7988105b5ad3a59b88c7fbccb205ff179ce5c",
        "0x1cef8d4d43f30e1b7ea39266d0564ce22ebeef7707a26f56117ff137b446396b",
        "0x127353ba63e08f74d8e9ce8a1c2b41b5f89c7167135b1c09fbed34a71b4cb06b",
        "0xc8b1407706f7ef44050faf5de114c17cde41c4c164587c5a63576b6e44aeb0d8",
        "0xd621b5373890ce0be9b20ca17a75c57944e8dbb997172fd61e1ea48af63fad96",
        "0xb6de0ed9198b5a23f3f22ea1f3b9dc5abee8f676c241e04dc77783ec38ca4ce6",
        "0xe4f745e6620e169ee2664111e61e448d2e0d58ea0129fd5fb0db940f5e0f801b",
        "0x3ce44383b860237d3a78a88caf9edcbec36b040d7be2998ef8222eec8719bd48",
        "0x325fc8e0610ad5403445c01009e6ab488082a24d61c1dfbd4b8f55184a2eb228",
        "0x2cedec528cb3c02b27986d8e2e1cefb35d1ee39ceb268f2e0c4e55179224216d",
        "0x9ecbc985b58baba5a91bbbb5116f6800537236c16df8dfd7ed51deb167f2a0a7",
        "0xf3a0002952bd691d1bd8c648378f4157299bffdc563ed1bbec4a5ba8adc89908",
        "0xb9908e50d9670d461d94d8cf06424e88e227a14e166db5c5c7ffd00ac32ad004",
        "0xac43ba1dc77038ea625533064bc276f27ae8fd315da602f3630d70b88d7861e3",
        "0x8a6f320a0d6cc6c944d836f72d9fa423a1868305bc65af03c0912c55ed00679f",
        "0x4878442cc9ccc8a6c02647abae4e8e00135c724a5b5e04fc99291d1880407816",
        "0x37983d1ee50b1e901cc0a265b92db6f452e6c483cfde079b64568386273a0671",
        "0x0d6e009807341aae5d0ccc3fbdc506fce77012603e96aec3fc44785942e7cf65",
      ],
      liquidityVenues: ["erc4626", "uniswapV3", "lifi"],
      pricers: ["morphoApi", "defillama", "uniswapV3"],
      liquidationBufferBps: 50,
      useFlashbots: false,
      useFlashLoans: true,
      blockInterval: 1,
      watchAllBorrowMarkets: true,
      preLiquidationHealthFactorThresholdBps: 10300,
      hotPathRpcReads: true,
      fullScanIntervalMs: 60_000,
      sequencerFeedUrl: "wss://feed.mainnet.chain.robinhood.com",
      hotPathPollMs: 30_000,
      triggerMinIntervalMs: 1_000,
      minProfitUsdFloor: 0.5,
      simFailureBackoffMs: 60_000,
      skippedUnprofitableBackoffMs: 60_000,
      maxDailyLosses: 6,
    },
  },
};
