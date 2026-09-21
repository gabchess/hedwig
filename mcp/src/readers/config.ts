// Reads the Solana role reader's own environment lazily, the first time a
// request actually names a cluster requiring it, then memoizes the result:
// a server whose every policy has "not-required" or no role never reads or
// logs these variables at all, and neither does a required-role policy
// naming a cluster or program id this reader does not recognise (the
// caller only reaches getSolanaClusterConfig after that much is already
// validated). No defaults: a cluster with no configured RPC URL or fee
// payer simply gets no config, and gatherSolanaRole treats that as "no
// call, no fact" rather than guessing an endpoint or an address. An RPC
// URL can carry an API key in its path, query string, or user-info, so
// this module never logs a URL's content, only the name of a variable
// that is missing or unusable.

export type SolanaReaderCluster = "devnet" | "mainnet-beta";

export interface SolanaClusterConfig {
  rpcUrl: string;
  feePayer: string;
}

const CLUSTER_ENV_SUFFIX: Readonly<Record<SolanaReaderCluster, string>> = {
  devnet: "DEVNET",
  "mainnet-beta": "MAINNET",
};

// https: always; http: only for a loopback host, and only after URL
// normalisation decides what the host actually is (a literal string
// comparison against the raw text would miss "HTTP://LOCALHOST" or a
// percent-encoded variant). User-info in the URL (`user:pass@host`) is
// refused outright: a real fetch throws on it, which would otherwise
// surface as a silent UNKNOWN instead of a diagnosable startup line.
function isUsableRpcUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return false;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  if (parsed.protocol !== "http:") {
    return false;
  }
  return (
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]"
  );
}

// Pure and env-injectable so a unit test can check its logic without ever
// touching the process's real environment. getSolanaClusterConfig below is
// the only caller that passes process.env; every reachability guard (which
// cluster, which variable names) lives here so `_MAINNET` can never read
// or fall back to a `_DEVNET` value or vice versa.
export function readClusterConfig(
  cluster: SolanaReaderCluster,
  env: NodeJS.ProcessEnv = process.env
): SolanaClusterConfig | undefined {
  const suffix = CLUSTER_ENV_SUFFIX[cluster];
  const urlVar = `HEDWIG_SOLANA_RPC_URL_${suffix}`;
  const feePayerVar = `HEDWIG_SOLANA_FEE_PAYER_${suffix}`;

  const rawUrl = env[urlVar]?.trim();
  const feePayer = env[feePayerVar]?.trim();

  if (!rawUrl) {
    console.error(`${urlVar} is not set`);
  } else if (!isUsableRpcUrl(rawUrl)) {
    console.error(`${urlVar} is not a usable URL`);
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
// that actually names it and only after the caller has already confirmed
// the policy is a well-formed, recognised required-role request: a
// caller cannot make this module log by sending requests, since only the
// owner's policy file ever reaches this far.
export function getSolanaClusterConfig(
  cluster: string
): SolanaClusterConfig | undefined {
  if (cluster !== "devnet" && cluster !== "mainnet-beta") {
    return undefined;
  }
  if (!cache.has(cluster)) {
    cache.set(cluster, readClusterConfig(cluster, process.env));
  }
  return cache.get(cluster);
}

// Test-only: clears the memoized config so a test can change
// process.env and observe a fresh read. Never called outside a test.
export function __resetSolanaClusterConfigForTests(): void {
  cache.clear();
}
