import { type Address } from "viem";

const QUERY = `
  query ExampleQuery($chainIds: [Int!]!) {
    vaults(where: { chainId_in: $chainIds, listed: true }) {
      items {
        address
        chain {
          id
        }
      }
    }
    vaultV2s(where: { chainId_in: $chainIds, listed: true }) {
      items {
        address
        chain {
          id
        }
      }
    }
  }
`;

interface VaultsResponse {
  data: {
    vaults: {
      items: { address: Address }[];
    };
    vaultV2s: {
      items: { address: Address }[];
    };
  };
  errors?: { message: string }[];
}

export async function fetchWhitelistedVaults(chainId: number): Promise<Address[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 10_000);
  try {
    const res = await fetch("https://blue-api.morpho.org/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { chainIds: [chainId] } }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`blue-api vault query failed: HTTP ${res.status}`);
      return [];
    }

    const json = (await res.json()) as VaultsResponse;

    if (json.errors?.length) {
      console.warn(json.errors.map((e) => e.message).join("\n"));
      return [];
    }

    // Era-2 chains (e.g. Robinhood 4663) list vaults under vaultV2s; classic
    // chains under vaults. Union both so either deployment model is covered.
    const addressSet = new Set<Address>([
      ...(json.data?.vaults?.items ?? []).map((item) => item.address),
      ...(json.data?.vaultV2s?.items ?? []).map((item) => item.address),
    ]);
    return [...addressSet];
  } catch (error) {
    console.warn("blue-api vault query failed:", error);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
