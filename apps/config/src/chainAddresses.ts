import {
  getChainAddresses,
  registerCustomAddresses,
  type ChainAddresses,
} from "@morpho-org/blue-sdk";
import { getAddress, type Address } from "viem";

/**
 * Era-2 Morpho Blue core addresses for chains not yet present in the pinned
 * `@morpho-org/blue-sdk` registry. @morpho-org/morpho-ts (>=2.7.0) already
 * knows these chains, but blue-sdk's own `getChainAddresses` registry lags.
 * Only the fields actually consumed by the client are required on the fallback.
 */
export const MORPHO_ADDRESS_OVERRIDES: Record<number, Address> = {
  // Robinhood Chain mainnet (era-2 deployment, block 286).
  [4663]: getAddress("0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010"),
};

/**
 * Era-2 chain addresses registered directly into the blue-sdk registry.
 * Registered at module load so that `getChainAddresses` (used by   * blue-sdk-viem's fetchMarket) resolves
 * these chains without patching node_modules copies.
 *
 * Sourced from morpho-org/sdks PR #841 (Robinhood Chain 4663 support).
 */
const ROBINHOOD_CHAIN_ADDRESSES = {
  morpho: getAddress("0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010"),
  permit2: getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
  bundler3: {
    bundler3: getAddress("0x6478e9393d4C5bB4d53ee881d1DE78786A0344a6"),
    generalAdapter1: getAddress("0xc5E188541D107e8B79e43478bDE365F1406665D6"),
  },
  adaptiveCurveIrm: getAddress("0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1"),
  vaultV2Factory: getAddress("0x0FBad98595b0186dA120E41f77C102beb49f803c"),
  morphoMarketV1AdapterV2Factory: getAddress("0x79370Ed003CE325C088E530d5e8655c99c2993e1"),
  morphoVaultV1AdapterFactory: getAddress("0x7a91222F3f7B927bB8fb624593Ca86e111C2F85e"),
  registryList: getAddress("0xe785a2eFD384BA7B95BaEd3851BC76aeD67C676f"),
  chainlinkOracleFactory: getAddress("0xB7c16F6F8cF531447Bf27Ca7220f981E79C9cdF2"),
  preLiquidationFactory: getAddress("0x0B0cFa151c06d2342799267754b0a2c320C43D5B"),
  wNative: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
} satisfies Partial<ChainAddresses>;

registerCustomAddresses({
  addresses: {
    [4663]: ROBINHOOD_CHAIN_ADDRESSES,
  } as unknown as Record<number, ChainAddresses>,
});

export function getChainAddressesWithOverrides(chainId: number): ChainAddresses {
  try {
    return getChainAddresses(chainId);
  } catch {
    const morpho = MORPHO_ADDRESS_OVERRIDES[chainId];
    if (!morpho)
      throw new Error(
        `No chain addresses found for chainId ${chainId} and no override is registered`,
      );
    return { morpho } as ChainAddresses;
  }
}
