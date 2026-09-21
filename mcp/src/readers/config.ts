// Reads the Solana role reader's own environment lazily, the first time a
// request actually names a cluster requiring it, then memoizes the result:
// a server whose every policy has "not-required" or no role never reads or
// logs these variables at all. No defaults: a cluster with no configured
// RPC URL or fee payer simply gets no config, and gatherSolanaRole treats
// that as "no call, no fact" rather than guessing an endpoint or an
// address. An RPC URL can carry an API key in its path or query string, so
// this module never logs a URL's content, only the name of a variable that
// is missing or unusable.

export type SolanaReaderCluster = "devnet" | "mainnet-beta";

export interface SolanaClusterConfig {
  rpcUrl: string;
  feePayer: string;
}

const CLUSTER_ENV_SUFFIX: Readonly<Record<SolanaReaderCluster, string>> = {
  devnet: "DEVNET",
  "mainnet-beta": "MAINNET",
};

function isUsableRpcUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  );
}

function readClusterConfig(
  cluster: SolanaReaderCluster
): SolanaClusterConfig | undefined {
  const suffix = CLUSTER_ENV_SUFFIX[cluster];
  const urlVar = `HEDWIG_SOLANA_RPC_URL_${suffix}`;
  const feePayerVar = `HEDWIG_SOLANA_FEE_PAYER_${suffix}`;

  const rawUrl = process.env[urlVar]?.trim();
  const feePayer = process.env[feePayerVar]?.trim();

  if (!rawUrl) {
    console.error(`${urlVar} is not set`);
  } else if (!isUsableRpcUrl(rawUrl)) {
    console.error(`${urlVar} is not a usable https URL`);
  }
  if (!feePayer) {
    console.error(`${feePayerVar} is not set`);
  }

  if (!rawUrl || !isUsableRpcUrl(rawUrl) || !feePayer) {
    return undefined;
  }
  return { rpcUrl: rawUrl, feePayer };
}

const cache = new Map<SolanaReaderCluster, SolanaClusterConfig | undefined>();

// Reads and logs at most once per cluster per process, on the first policy
// that actually names it: a caller cannot make this module log by sending
// requests, since only the owner's policy file ever names a cluster.
export function getSolanaClusterConfig(
  cluster: string
): SolanaClusterConfig | undefined {
  if (cluster !== "devnet" && cluster !== "mainnet-beta") {
    return undefined;
  }
  if (!cache.has(cluster)) {
    cache.set(cluster, readClusterConfig(cluster));
  }
  return cache.get(cluster);
}

// Test-only: clears the memoized config so a test can change
// process.env and observe a fresh read. Never called outside a test.
export function __resetSolanaClusterConfigForTests(): void {
  cache.clear();
}
