import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Shared pieces for the registry Reader tests: ed25519 test keys, rows that
// carry exactly the fields the Reader reads (the registry repository's own
// verify covers the full row schema), a fake registry host and a fake
// JSON-RPC endpoint that answer from recorded chain state.

export const BASE = "https://registry.test";
export const RPC_URL = "https://rpc.test/v2/test-key";

// Unix seconds, inside the validity window of every row below.
export const NOW = Date.parse("2026-10-10T00:00:00Z") / 1000;
export const VERIFIED_AT = "2026-10-03T06:51:35Z";
export const EXPIRES_AT = "2026-11-02T06:51:35Z";
export const EXPIRES_AT_SECONDS = Date.parse(EXPIRES_AT) / 1000;

export const ZERO_WORD = "0x" + "0".repeat(64);
export const SLOT_EIP1967 =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const SLOT_ZEPPELINOS =
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
export const SLOT_BEACON =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
export const ASSET_CALL = "0x38d52e0f";

export interface TestKeys {
  a: KeyObject;
  b: KeyObject;
  pub: { a: string; b: string };
}

function rawPublic(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("base64");
}

export function makeKeys(): TestKeys {
  const a = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("ed25519");
  return {
    a: a.privateKey,
    b: b.privateKey,
    pub: { a: rawPublic(a.publicKey), b: rawPublic(b.publicKey) },
  };
}

export function envelope(
  payload: Buffer,
  signers: { a?: KeyObject | null; b?: KeyObject | null }
): string {
  const slot = (key: KeyObject | null | undefined) =>
    key ? sign(null, payload, key).toString("base64") : null;
  return (
    JSON.stringify({
      v: 1,
      payload: payload.toString("base64"),
      signatures: [slot(signers.a), slot(signers.b)],
    }) + "\n"
  );
}

export function signed(row: unknown, keys: TestKeys): string {
  return envelope(Buffer.from(JSON.stringify(row, null, 2) + "\n"), keys);
}

export function sha256OfHex(hex: string): string {
  return createHash("sha256")
    .update(Buffer.from(hex.slice(2), "hex"))
    .digest("hex");
}

export function wordOfAddress(address: string): string {
  return "0x" + "0".repeat(24) + address.slice(2).toLowerCase();
}

export function wordOfNumber(value: bigint): string {
  return "0x" + value.toString(16).padStart(64, "0");
}

export function previewCall(vault: string, amount: bigint): string {
  return `${vault}:0xef8b30f7${amount.toString(16).padStart(64, "0")}`;
}

// --- recorded chain data ----------------------------------------------------

const FIXTURES = join(__dirname, "fixtures", "registry");

function fixtureCode(address: string): string {
  const recorded = JSON.parse(
    readFileSync(join(FIXTURES, `${address}.code.json`), "utf8")
  ) as { code: string };
  return recorded.code;
}

// The real Monad USDC proxy and its implementation, read from public Monad
// RPC. Their sha256 hashes are the ones the registry row records.
export const MONAD_USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
export const MONAD_USDC_IMPL = "0xbd520ea8cbb4f81b62aff3c3ffe7affd69800b6d";
export const MONAD_USDC_CODE = fixtureCode(MONAD_USDC);
export const MONAD_USDC_IMPL_CODE = fixtureCode(MONAD_USDC_IMPL);
export const MONAD_USDC_HASH =
  "bde7e5c4c0469cca18f98a08948b558f5df3cb03b5ce4d44663f806ae36ac362";
export const MONAD_USDC_IMPL_HASH =
  "d8b6a62a96704481d17d258aaf2bb7360b2f554793fe65fc4e4b1fe545d1607b";

export const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
export const USDT_CODE = "0x6080604052600a600b0160005260206000f3";
export const STEAK = "0xbeef047a543e45807105e51a8bbefcc5950fcfba";
export const STEAK_CODE = "0x608060405234801561001057600080fd5b50600436106100";
export const SPARK = "0xe2e7a17dff93280dec073c995595155283e3c372";
export const SPARK_CODE = "0x6080604052366000803760008036600073";
export const SPARK_IMPL = "0x1b992302652a92611dcd5090d1cb388c6377f455";
export const SPARK_IMPL_CODE =
  "0x608060405234801561001057600080fd5b506004361061ff";
export const SPARK_OTHER_IMPL = "0x2222222222222222222222222222222222222222";

// --- rows -------------------------------------------------------------------

export interface TokenRowSpec {
  chainId: number;
  symbol: string;
  contractAddress: string;
  codeSha256: string;
  upgradeable?:
    | false
    | { kind: "zeppelinos" | "eip1967"; implementation: string; hash: string };
  sequence?: number;
  verifiedAt?: string;
  expiresAt?: string;
  patch?: Record<string, unknown>;
}

export function tokenRow(spec: TokenRowSpec): Record<string, unknown> {
  const up = spec.upgradeable ?? false;
  return {
    schemaVersion: 1,
    type: "token",
    chainId: spec.chainId,
    symbol: spec.symbol,
    contractAddress: spec.contractAddress,
    decimals: 6,
    upgradeable:
      up === false
        ? false
        : {
            kind: up.kind,
            slot: up.kind === "zeppelinos" ? SLOT_ZEPPELINOS : SLOT_EIP1967,
            implementation: up.implementation,
            implementationCodeSha256: up.hash,
          },
    codeSha256: spec.codeSha256,
    evidence: [],
    curators: ["curator-a", "curator-b"],
    verifiedAt: spec.verifiedAt ?? VERIFIED_AT,
    expiresAt: spec.expiresAt ?? EXPIRES_AT,
    sequence: spec.sequence ?? 1,
    ...spec.patch,
  };
}

export interface VaultRowSpec {
  chainId: number;
  contractAddress: string;
  asset: string;
  codeSha256: string;
  upgradeable?: unknown;
  implementation?: { address: string; codeSha256: string };
  sequence?: number;
  verifiedAt?: string;
  expiresAt?: string;
  patch?: Record<string, unknown>;
}

export function vaultRow(spec: VaultRowSpec): Record<string, unknown> {
  return {
    schemaVersion: 1,
    type: "vault",
    chainId: spec.chainId,
    contractAddress: spec.contractAddress,
    asset: spec.asset,
    upgradeable: spec.upgradeable ?? "none",
    ...(spec.implementation ? { implementation: spec.implementation } : {}),
    codeSha256: spec.codeSha256,
    depositChecks: [],
    evidence: [],
    curators: ["curator-a", "curator-b"],
    verifiedAt: spec.verifiedAt ?? VERIFIED_AT,
    expiresAt: spec.expiresAt ?? EXPIRES_AT,
    sequence: spec.sequence ?? 1,
    ...spec.patch,
  };
}

export const monadUsdcRow = (extra: Partial<TokenRowSpec> = {}) =>
  tokenRow({
    chainId: 143,
    symbol: "USDC",
    contractAddress: MONAD_USDC,
    codeSha256: MONAD_USDC_HASH,
    upgradeable: {
      kind: "zeppelinos",
      implementation: MONAD_USDC_IMPL,
      hash: MONAD_USDC_IMPL_HASH,
    },
    ...extra,
  });

export const usdtRow = (extra: Partial<TokenRowSpec> = {}) =>
  tokenRow({
    chainId: 1,
    symbol: "USDT",
    contractAddress: USDT,
    codeSha256: sha256OfHex(USDT_CODE),
    ...extra,
  });

export const steakRow = (extra: Partial<VaultRowSpec> = {}) =>
  vaultRow({
    chainId: 1,
    contractAddress: STEAK,
    asset: USDT,
    codeSha256: sha256OfHex(STEAK_CODE),
    ...extra,
  });

export const sparkRow = (extra: Partial<VaultRowSpec> = {}) =>
  vaultRow({
    chainId: 1,
    contractAddress: SPARK,
    asset: USDT,
    upgradeable: "eip1967",
    implementation: {
      address: SPARK_IMPL,
      codeSha256: sha256OfHex(SPARK_IMPL_CODE),
    },
    codeSha256: sha256OfHex(SPARK_CODE),
    ...extra,
  });

// --- the fake world ---------------------------------------------------------

export interface ChainState {
  code: Record<string, string>;
  storage: Record<string, string>;
  // `${to}:${data}` to a result word, or "revert".
  calls: Record<string, string>;
  block: number;
}

export interface Logged {
  url: string;
  method: string;
  body: string | undefined;
}

export type RpcMode = "ok" | "reject" | "http500" | "garbage" | "reversed";

export interface World {
  // Row files by repository path, e.g. `v1/eip155-143/USDC.json`.
  files: Record<string, string>;
  chain: ChainState;
  rpcMode: RpcMode;
  log: Logged[];
  fetch: typeof globalThis.fetch;
}

export function emptyChain(): ChainState {
  return { code: {}, storage: {}, calls: {}, block: 26110209 };
}

export function monadChain(): ChainState {
  return {
    code: {
      [MONAD_USDC]: MONAD_USDC_CODE,
      [MONAD_USDC_IMPL]: MONAD_USDC_IMPL_CODE,
    },
    storage: {
      [`${MONAD_USDC}:${SLOT_ZEPPELINOS}`]: wordOfAddress(MONAD_USDC_IMPL),
    },
    calls: {},
    block: 110116380,
  };
}

export function steakChain(amount = 1000000n): ChainState {
  return {
    code: { [USDT]: USDT_CODE, [STEAK]: STEAK_CODE },
    storage: {},
    calls: {
      [`${STEAK}:${ASSET_CALL}`]: wordOfAddress(USDT),
      [previewCall(STEAK, amount)]: wordOfNumber(882612176477205266n),
    },
    block: 26110209,
  };
}

export function sparkChain(amount = 1000000n): ChainState {
  return {
    code: { [SPARK]: SPARK_CODE, [SPARK_IMPL]: SPARK_IMPL_CODE },
    storage: { [`${SPARK}:${SLOT_EIP1967}`]: wordOfAddress(SPARK_IMPL) },
    calls: {
      [`${SPARK}:${ASSET_CALL}`]: wordOfAddress(USDT),
      [previewCall(SPARK, amount)]: wordOfNumber(1000000n),
    },
    block: 26110209,
  };
}

function answer(chain: ChainState, call: Record<string, unknown>): unknown {
  const params = call.params as unknown[];
  const id = call.id;
  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
  const error = () => ({
    jsonrpc: "2.0",
    id,
    error: { code: 3, message: "execution reverted" },
  });
  switch (call.method) {
    case "eth_getCode":
      return result(chain.code[String(params[0]).toLowerCase()] ?? "0x");
    case "eth_getStorageAt":
      return result(
        chain.storage[`${String(params[0]).toLowerCase()}:${params[1]}`] ??
          ZERO_WORD
      );
    case "eth_blockNumber":
      return result("0x" + chain.block.toString(16));
    case "eth_call": {
      const c = params[0] as { to: string; data: string };
      const hit = chain.calls[`${c.to.toLowerCase()}:${c.data}`];
      return hit === undefined || hit === "revert" ? error() : result(hit);
    }
    default:
      return error();
  }
}

export function makeWorld(
  files: Record<string, string>,
  chain: ChainState = emptyChain()
): World {
  const world: World = {
    files,
    chain,
    rpcMode: "ok",
    log: [],
    fetch: undefined as unknown as typeof fetch,
  };
  world.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    world.log.push({ url, method, body });
    if (url.startsWith(BASE + "/")) {
      const text = world.files[url.slice(BASE.length + 1)];
      return text === undefined
        ? new Response("not found", { status: 404 })
        : new Response(text, { status: 200 });
    }
    if (url === RPC_URL && method === "POST" && body !== undefined) {
      if (world.rpcMode === "reject") {
        throw new TypeError("fetch failed");
      }
      if (world.rpcMode === "http500") {
        return new Response("boom", { status: 500 });
      }
      if (world.rpcMode === "garbage") {
        return new Response("<html>not json</html>", { status: 200 });
      }
      const calls = JSON.parse(body) as Array<Record<string, unknown>>;
      const replies = calls.map((c) => answer(world.chain, c));
      if (world.rpcMode === "reversed") {
        replies.reverse();
      }
      return new Response(JSON.stringify(replies), { status: 200 });
    }
    throw new TypeError(`unexpected request to ${url}`);
  }) as typeof globalThis.fetch;
  return world;
}

export const rpcLog = (world: World) =>
  world.log.filter((entry) => entry.url === RPC_URL);
export const rowLog = (world: World) =>
  world.log.filter((entry) => entry.url.startsWith(BASE + "/"));
