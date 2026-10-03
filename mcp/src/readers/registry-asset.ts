import { createHash, createPublicKey, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { canonicalAddressFor } from "@hedwig/consult/canonical";
import {
  REGISTRY_PUBLIC_KEY_A,
  REGISTRY_PUBLIC_KEY_B,
} from "@hedwig/consult/registry-keys";
import type {
  RegistryAssetFact,
  RegistryCodeHashRead,
  RegistryLiveRead,
  RegistryVaultFact,
} from "@hedwig/consult";

import { readBoundedBody } from "./solana-role";

// Reads a signed registry row for the token (and, for a deposit, the vault)
// a request names, confirms it against the chain, and returns it as the
// Facts consult() weighs. Never throws, never rejects, and settles within
// deps.deadlineMs: one deadline bounds the row fetch and the chain batch
// together, with no retry. A row that cannot be trusted gives no Fact. A row
// that is trusted but whose live read could not be completed still gives a
// Fact, one that says so.
//
// What may reach a network call: the registry base URL and the RPC URLs
// come from the host's configuration, the keys from consult's constants. The
// request supplies only a chain number (digits), a token symbol (uppercase
// letters and digits) and a vault address (hex), each checked against its
// strict shape first and then written into a fixed path by this file. The
// request body of a chain batch carries only the vault or token address,
// the pinned implementation address and the stated amount.

export const REGISTRY_DEADLINE_MS = 800;

const MAX_ROW_BYTES = 256 * 1024;
const MAX_RPC_RESPONSE_BYTES = 512 * 1024;

const SLOT_EIP1967 =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SLOT_ZEPPELINOS =
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
const ASSET_SELECTOR = "0x38d52e0f";
const PREVIEW_DEPOSIT_SELECTOR = "0xef8b30f7";

const ZERO_HIGH_BYTES = "0".repeat(24);
const MAX_UINT256 = (1n << 256n) - 1n;

// The pair consult ships. Both are empty until the signing sitting, and an
// empty pair rejects every row.
export const PINNED_REGISTRY_KEYS: Readonly<{ a: string; b: string }> =
  Object.freeze({ a: REGISTRY_PUBLIC_KEY_A, b: REGISTRY_PUBLIC_KEY_B });

export interface RegistryRatchet {
  // True when `sequence` is not lower than the highest one this key has
  // carried, and records it. A lower one is a rolled-back row.
  admit(key: string, sequence: number): boolean;
}

export interface RegistryDeps {
  fetch: typeof globalThis.fetch;
  // Unix seconds.
  now: () => number;
  deadlineMs: number;
  keys: { a: string; b: string };
  // Resolved only when a request needs a lookup, so a deployment that never
  // sees an unlisted token never reads or logs the registry settings.
  registry: () => { baseUrl: string; ratchet: RegistryRatchet } | undefined;
  // Called only after a row for that chain verified.
  rpcUrlFor: (chainNumber: number) => string | undefined;
}

export interface RegistryFacts {
  registryAsset?: RegistryAssetFact;
  registryVault?: RegistryVaultFact;
}

// --- the sequence ratchet ---------------------------------------------------

// A file of the highest sequence seen per row key, written whole through a
// temporary file and a rename. When the file cannot be written (a sandboxed
// Host, a read-only home) the ratchet keeps working in memory for the life
// of the process. A file that exists but is not a table of positive
// integers is not trusted and not overwritten: admit answers false until
// the owner fixes or removes it.
export function createRatchet(file: string): RegistryRatchet {
  const memory = new Map<string, number>();
  let warnedCorrupt = false;
  let warnedWrite = false;

  function load(): Map<string, number> | "corrupt" | undefined {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === "ENOENT"
        ? new Map()
        : undefined;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        return "corrupt";
      }
      const table = new Map<string, number>();
      for (const [key, value] of Object.entries(parsed)) {
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < 1
        ) {
          return "corrupt";
        }
        table.set(key, value);
      }
      return table;
    } catch {
      return "corrupt";
    }
  }

  function warnMemoryOnly(): void {
    if (!warnedWrite) {
      warnedWrite = true;
      console.error(
        "hedwig-mcp: the registry ratchet file could not be used; this process keeps the ratchet in memory only"
      );
    }
  }

  function save(table: Map<string, number>): void {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(Object.fromEntries(table)), {
        mode: 0o600,
      });
      renameSync(temporary, file);
    } catch {
      warnMemoryOnly();
    }
  }

  return {
    admit(key: string, sequence: number): boolean {
      const loaded = load();
      if (loaded === "corrupt") {
        if (!warnedCorrupt) {
          warnedCorrupt = true;
          console.error(
            "hedwig-mcp: the registry ratchet file is not a table of sequences; answering with no registry fact until it is fixed or removed"
          );
        }
        return false;
      }
      if (loaded === undefined) {
        warnMemoryOnly();
      }
      const onDisk = loaded?.get(key) ?? 0;
      if (sequence < Math.max(onDisk, memory.get(key) ?? 0)) {
        return false;
      }
      memory.set(key, sequence);
      if (loaded !== undefined && sequence > onDisk) {
        loaded.set(key, sequence);
        save(loaded);
      }
      return true;
    },
  };
}

const sharedRatchets = new Map<string, RegistryRatchet>();

// One ratchet per file for the life of the process, so the memory half of a
// fallback survives from one request to the next.
export function sharedRatchet(file: string): RegistryRatchet {
  let ratchet = sharedRatchets.get(file);
  if (!ratchet) {
    ratchet = createRatchet(file);
    sharedRatchets.set(file, ratchet);
  }
  return ratchet;
}

// --- the signed envelope ----------------------------------------------------

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function canonicalBase64(value: unknown, bytes?: number): Buffer | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.toString("base64") !== value) {
    return undefined;
  }
  return bytes === undefined || buffer.length === bytes ? buffer : undefined;
}

function readPublicKey(b64: string): KeyObject | undefined {
  const raw = canonicalBase64(b64, 32);
  if (!raw) {
    return undefined;
  }
  try {
    return createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    return undefined;
  }
}

interface VerifyingKeys {
  a: KeyObject;
  b: KeyObject;
}

// Both keys must be well-formed and distinct, or no row is ever accepted.
function readKeys(keys: { a: string; b: string }): VerifyingKeys | undefined {
  if (typeof keys.a !== "string" || typeof keys.b !== "string") {
    return undefined;
  }
  if (keys.a === keys.b) {
    return undefined;
  }
  const a = readPublicKey(keys.a);
  const b = readPublicKey(keys.b);
  return a && b ? { a, b } : undefined;
}

// `{"v":1,"payload":<base64 of the row bytes>,"signatures":[a,b]}`. Slot a
// verifies under key a and slot b under key b, over the raw payload bytes.
// Both are required. The bytes are checked before anything is parsed out of
// them.
function openEnvelope(text: string, keys: VerifyingKeys): Buffer | undefined {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope)
  ) {
    return undefined;
  }
  const record = envelope as Record<string, unknown>;
  if (
    record.v !== 1 ||
    Object.keys(record).sort().join() !== "payload,signatures,v"
  ) {
    return undefined;
  }
  const payload = canonicalBase64(record.payload);
  if (!payload || payload.length === 0) {
    return undefined;
  }
  const signatures = record.signatures;
  if (!Array.isArray(signatures) || signatures.length !== 2) {
    return undefined;
  }
  const signatureA = canonicalBase64(signatures[0], 64);
  const signatureB = canonicalBase64(signatures[1], 64);
  if (!signatureA || !signatureB) {
    return undefined;
  }
  try {
    if (
      !verify(null, payload, keys.a, signatureA) ||
      !verify(null, payload, keys.b, signatureB)
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return payload;
}

// --- the row ----------------------------------------------------------------

const ADDRESS_ROW = /^0x[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ROW_SYMBOL = /^[A-Z0-9]{1,20}$/;
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

interface RowBase {
  chainNumber: number;
  contractAddress: string;
  codeSha256: string;
  sequence: number;
  verifiedAt: number;
  expiresAt: number;
}

interface TokenRow extends RowBase {
  type: "token";
  symbol: string;
  proxy?: {
    slot: string;
    implementation: string;
    implementationCodeSha256: string;
  };
}

interface VaultRow extends RowBase {
  type: "vault";
  asset: string;
  upgradeable: "none" | "eip1967";
  implementation?: { address: string; codeSha256: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isoToSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" || !ISO_SECONDS.test(value)) {
    return undefined;
  }
  const ms = Date.parse(value);
  if (
    Number.isNaN(ms) ||
    new Date(ms).toISOString().slice(0, 19) + "Z" !== value
  ) {
    return undefined;
  }
  return ms / 1000;
}

function readRowBase(row: Record<string, unknown>): RowBase | undefined {
  const { chainId, contractAddress, codeSha256, sequence } = row;
  const verifiedAt = isoToSeconds(row.verifiedAt);
  const expiresAt = isoToSeconds(row.expiresAt);
  if (
    row.schemaVersion !== 1 ||
    typeof chainId !== "number" ||
    !Number.isSafeInteger(chainId) ||
    chainId < 1 ||
    typeof contractAddress !== "string" ||
    !ADDRESS_ROW.test(contractAddress) ||
    typeof codeSha256 !== "string" ||
    !SHA256_HEX.test(codeSha256) ||
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    verifiedAt === undefined ||
    expiresAt === undefined ||
    expiresAt <= verifiedAt
  ) {
    return undefined;
  }
  return {
    chainNumber: chainId,
    contractAddress,
    codeSha256,
    sequence,
    verifiedAt,
    expiresAt,
  };
}

function readTokenRow(
  row: Record<string, unknown>,
  base: RowBase
): TokenRow | undefined {
  const symbol = row.symbol;
  if (typeof symbol !== "string" || !ROW_SYMBOL.test(symbol)) {
    return undefined;
  }
  const upgradeable = row.upgradeable;
  if (upgradeable === false) {
    return { ...base, type: "token", symbol };
  }
  if (!isObject(upgradeable)) {
    return undefined;
  }
  const { kind, slot, implementation, implementationCodeSha256 } = upgradeable;
  const expectedSlot =
    kind === "zeppelinos"
      ? SLOT_ZEPPELINOS
      : kind === "eip1967"
      ? SLOT_EIP1967
      : undefined;
  if (
    expectedSlot === undefined ||
    slot !== expectedSlot ||
    typeof implementation !== "string" ||
    !ADDRESS_ROW.test(implementation) ||
    typeof implementationCodeSha256 !== "string" ||
    !SHA256_HEX.test(implementationCodeSha256)
  ) {
    return undefined;
  }
  return {
    ...base,
    type: "token",
    symbol,
    proxy: { slot: expectedSlot, implementation, implementationCodeSha256 },
  };
}

// A vault row's `upgradeable` is `none` or `eip1967`; any other value is
// refused. An `eip1967` row must pin the implementation's address and code
// hash, a `none` row must carry no implementation, and either break is a
// malformed row.
function readVaultRow(
  row: Record<string, unknown>,
  base: RowBase
): VaultRow | undefined {
  const asset = row.asset;
  if (typeof asset !== "string" || !ADDRESS_ROW.test(asset)) {
    return undefined;
  }
  const upgradeable = row.upgradeable;
  const implementation = row.implementation;
  if (upgradeable === "none" && implementation === undefined) {
    return { ...base, type: "vault", asset, upgradeable };
  }
  if (upgradeable !== "eip1967" || !isObject(implementation)) {
    return undefined;
  }
  const { address, codeSha256 } = implementation;
  if (
    typeof address !== "string" ||
    !ADDRESS_ROW.test(address) ||
    typeof codeSha256 !== "string" ||
    !SHA256_HEX.test(codeSha256)
  ) {
    return undefined;
  }
  return {
    ...base,
    type: "vault",
    asset,
    upgradeable,
    implementation: { address, codeSha256 },
  };
}

function readRow(payload: Buffer): TokenRow | VaultRow | undefined {
  let row: unknown;
  try {
    row = JSON.parse(payload.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isObject(row)) {
    return undefined;
  }
  const base = readRowBase(row);
  if (!base) {
    return undefined;
  }
  if (row.type === "token") {
    return readTokenRow(row, base);
  }
  if (row.type === "vault") {
    return readVaultRow(row, base);
  }
  return undefined;
}

// --- the request ------------------------------------------------------------

const CHAIN_ID_SHAPE = /^eip155:([1-9][0-9]{0,14})$/;
const REQUEST_SYMBOL_SHAPE = /^[A-Z0-9]{1,20}$/;
const REQUEST_ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT_SHAPE = /^(0|[1-9][0-9]{0,77})$/;

interface Lookup {
  chainId: string;
  chainNumber: number;
  // The first symbol the code table does not already list, if any.
  tokenSymbol?: string;
  vault?: {
    address: string;
    // The deposit token's symbol, for the canonical-asset check.
    symbol: string | undefined;
    amount: bigint | undefined;
  };
}

function stringField(source: unknown, key: string): string | undefined {
  if (!isObject(source)) {
    return undefined;
  }
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function symbolOf(source: unknown): string | undefined {
  return isObject(source) ? stringField(source, "symbol") : undefined;
}

function readLookup(request: unknown): Lookup | undefined {
  if (!isObject(request) || !isObject(request.action)) {
    return undefined;
  }
  const action = request.action;
  const chainId = action.chainId;
  const matched =
    typeof chainId === "string" ? CHAIN_ID_SHAPE.exec(chainId) : null;
  if (typeof chainId !== "string" || !matched) {
    return undefined;
  }
  const chainNumber = Number(matched[1]);

  let symbols: Array<string | undefined>;
  switch (action.type) {
    case "pay":
    case "deposit":
      symbols = [symbolOf(action.asset)];
      break;
    case "swap":
      symbols = [symbolOf(action.tokenIn), symbolOf(action.tokenOut)];
      break;
    default:
      return undefined;
  }
  const tokenSymbol = symbols.find(
    (symbol): symbol is string =>
      symbol !== undefined &&
      REQUEST_SYMBOL_SHAPE.test(symbol) &&
      canonicalAddressFor(chainId, symbol, undefined) === undefined
  );

  let vault: Lookup["vault"];
  if (action.type === "deposit") {
    const target = stringField(action, "target");
    if (target !== undefined && REQUEST_ADDRESS_SHAPE.test(target)) {
      const amountText = stringField(action, "amount");
      const amount =
        amountText !== undefined && AMOUNT_SHAPE.test(amountText)
          ? BigInt(amountText)
          : undefined;
      vault = {
        address: target.toLowerCase(),
        symbol: symbols[0],
        amount:
          amount !== undefined && amount <= MAX_UINT256 ? amount : undefined,
      };
    }
  }

  if (tokenSymbol === undefined && vault === undefined) {
    return undefined;
  }
  return { chainId, chainNumber, tokenSymbol, vault };
}

// --- the network ------------------------------------------------------------

const TIMED_OUT = Symbol("timed-out");

// Runs one stage under whatever is left of the shared deadline. On expiry
// the shared controller aborts, so a well-behaved fetch or body stream
// stops too, and the stage's own late result is dropped.
async function within<T>(
  deadlineAt: number,
  controller: AbortController,
  run: () => Promise<T>
): Promise<T | typeof TIMED_OUT> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    controller.abort();
    return TIMED_OUT;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMED_OUT);
    }, remaining);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function requestText(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  maxBytes: number,
  fetchFn: typeof globalThis.fetch,
  controller: AbortController
): Promise<string | undefined> {
  const response = await fetchFn(url, {
    ...init,
    redirect: "error",
    signal: controller.signal,
  });
  if (response.status !== 200 || response.redirected === true) {
    return undefined;
  }
  return readBoundedBody(response, maxBytes, controller);
}

// Every path is built from values that already passed their shape check:
// digits, uppercase letters and digits, lowercase hex. The built URL is then
// held to the configured base's origin and path as a last check.
function rowUrl(baseUrl: string, path: string): string | undefined {
  try {
    const base = new URL(baseUrl);
    const url = new URL(`${baseUrl}/${path}`);
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(`${base.pathname.replace(/\/+$/, "")}/v1/`) ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

interface RpcCall {
  id: number;
  method: string;
  params: unknown[];
}

// One JSON-RPC batch. Results are matched by id, never by position. An entry
// that is missing, carries an error, repeats an id, or names an id this
// batch never sent is simply absent from the map.
function parseBatch(
  text: string | undefined,
  calls: readonly RpcCall[]
): Map<number, unknown> {
  const results = new Map<number, unknown>();
  if (text === undefined) {
    return results;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return results;
  }
  if (!Array.isArray(parsed) || parsed.length > calls.length) {
    return results;
  }
  const sent = new Set(calls.map((call) => call.id));
  const seen = new Set<number>();
  const poisoned = new Set<number>();
  for (const entry of parsed) {
    if (!isObject(entry) || entry.jsonrpc !== "2.0") {
      continue;
    }
    const id = entry.id;
    if (typeof id !== "number" || !sent.has(id)) {
      continue;
    }
    if (seen.has(id)) {
      poisoned.add(id);
      continue;
    }
    seen.add(id);
    if ("error" in entry || !("result" in entry)) {
      continue;
    }
    results.set(id, entry.result);
  }
  for (const id of poisoned) {
    results.delete(id);
  }
  return results;
}

async function postBatch(
  rpcUrl: string,
  calls: readonly RpcCall[],
  deps: RegistryDeps,
  controller: AbortController
): Promise<string | undefined> {
  try {
    return await requestText(
      rpcUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          calls.map((call) => ({
            jsonrpc: "2.0",
            id: call.id,
            method: call.method,
            params: call.params,
          }))
        ),
      },
      MAX_RPC_RESPONSE_BYTES,
      deps.fetch,
      controller
    );
  } catch {
    return undefined;
  }
}

function codeSha256Of(result: unknown): string | undefined {
  if (typeof result !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(result)) {
    return undefined;
  }
  return createHash("sha256")
    .update(Buffer.from(result.slice(2), "hex"))
    .digest("hex");
}

function compareHash(result: unknown, expected: string): RegistryCodeHashRead {
  const actual = codeSha256Of(result);
  if (actual === undefined) {
    return "unread";
  }
  return actual === expected ? "match" : "mismatch";
}

function wordOf(result: unknown): string | undefined {
  return typeof result === "string" && /^0x[0-9a-fA-F]{64}$/.test(result)
    ? result.toLowerCase()
    : undefined;
}

function addressOfWord(word: string | undefined): string | undefined {
  return word !== undefined && word.slice(2, 26) === ZERO_HIGH_BYTES
    ? `0x${word.slice(26)}`
    : undefined;
}

function blockOf(result: unknown): number | undefined {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{1,13}$/.test(result)) {
    return undefined;
  }
  const block = parseInt(result.slice(2), 16);
  return Number.isSafeInteger(block) && block > 0 ? block : undefined;
}

// --- the token half ---------------------------------------------------------

const LATEST = "latest";

function liveReadOfToken(
  row: TokenRow,
  results: Map<number, unknown>
): RegistryLiveRead {
  const reads: RegistryCodeHashRead[] = [
    compareHash(results.get(1), row.codeSha256),
  ];
  if (row.proxy) {
    // The row's own slot, not a slot this reader picks: Circle's USDC keeps
    // its implementation in the legacy ZeppelinOS slot and reads zero in
    // the EIP-1967 one.
    const word = wordOf(results.get(2));
    const held = addressOfWord(word);
    reads.push(
      word === undefined
        ? "unread"
        : held === row.proxy.implementation
        ? "match"
        : "mismatch",
      compareHash(results.get(3), row.proxy.implementationCodeSha256)
    );
  }
  if (reads.includes("mismatch")) {
    return "mismatch";
  }
  return reads.includes("unread") ? "unconfirmed" : "confirmed";
}

async function readTokenFact(
  lookup: Lookup & { tokenSymbol: string },
  deps: RegistryDeps,
  config: { baseUrl: string; ratchet: RegistryRatchet },
  keys: VerifyingKeys
): Promise<RegistryAssetFact | undefined> {
  try {
    const deadlineAt = Date.now() + deps.deadlineMs;
    const controller = new AbortController();
    const url = rowUrl(
      config.baseUrl,
      `v1/eip155-${lookup.chainNumber}/${lookup.tokenSymbol}.json`
    );
    if (url === undefined) {
      return undefined;
    }
    const text = await within(deadlineAt, controller, () =>
      requestText(
        url,
        { method: "GET", headers: { accept: "application/json" } },
        MAX_ROW_BYTES,
        deps.fetch,
        controller
      )
    );
    if (text === TIMED_OUT || text === undefined) {
      return undefined;
    }
    const payload = openEnvelope(text, keys);
    const row = payload ? readRow(payload) : undefined;
    const now = deps.now();
    if (
      !row ||
      row.type !== "token" ||
      row.chainNumber !== lookup.chainNumber ||
      row.symbol !== lookup.tokenSymbol ||
      !Number.isSafeInteger(now) ||
      now <= 0 ||
      row.verifiedAt > now ||
      row.expiresAt <= now ||
      !config.ratchet.admit(
        `token:${row.chainNumber}:${row.symbol}`,
        row.sequence
      )
    ) {
      return undefined;
    }

    const rpcUrl = deps.rpcUrlFor(row.chainNumber);
    const liveReadAt = deps.now();
    let liveRead: RegistryLiveRead = "unconfirmed";
    if (rpcUrl !== undefined) {
      const calls: RpcCall[] = [
        { id: 1, method: "eth_getCode", params: [row.contractAddress, LATEST] },
      ];
      if (row.proxy) {
        calls.push(
          {
            id: 2,
            method: "eth_getStorageAt",
            params: [row.contractAddress, row.proxy.slot, LATEST],
          },
          {
            id: 3,
            method: "eth_getCode",
            params: [row.proxy.implementation, LATEST],
          }
        );
      }
      const reply = await within(deadlineAt, controller, () =>
        postBatch(rpcUrl, calls, deps, controller)
      );
      liveRead = liveReadOfToken(
        row,
        parseBatch(reply === TIMED_OUT ? undefined : reply, calls)
      );
    }
    return {
      chainId: lookup.chainId,
      symbol: row.symbol,
      contractAddress: row.contractAddress,
      expiresAt: row.expiresAt,
      liveRead,
      liveReadAt,
    };
  } catch {
    return undefined;
  }
}

// --- the vault half ---------------------------------------------------------

async function readVaultFact(
  lookup: Lookup & { vault: NonNullable<Lookup["vault"]> },
  deps: RegistryDeps,
  config: { baseUrl: string; ratchet: RegistryRatchet },
  keys: VerifyingKeys,
  tokenFact: Promise<RegistryAssetFact | undefined>
): Promise<RegistryVaultFact | undefined> {
  try {
    const deadlineAt = Date.now() + deps.deadlineMs;
    const controller = new AbortController();
    const { vault } = lookup;
    const url = rowUrl(
      config.baseUrl,
      `v1/vaults/eip155-${lookup.chainNumber}/${vault.address}.json`
    );
    if (url === undefined) {
      return undefined;
    }
    const text = await within(deadlineAt, controller, () =>
      requestText(
        url,
        { method: "GET", headers: { accept: "application/json" } },
        MAX_ROW_BYTES,
        deps.fetch,
        controller
      )
    );
    if (text === TIMED_OUT || text === undefined) {
      return undefined;
    }
    const payload = openEnvelope(text, keys);
    const row = payload ? readRow(payload) : undefined;
    const now = deps.now();
    if (
      !row ||
      row.type !== "vault" ||
      row.chainNumber !== lookup.chainNumber ||
      row.contractAddress !== vault.address ||
      !Number.isSafeInteger(now) ||
      now <= 0 ||
      row.verifiedAt > now ||
      row.expiresAt <= now ||
      !config.ratchet.admit(
        `vault:${row.chainNumber}:${row.contractAddress}`,
        row.sequence
      )
    ) {
      return undefined;
    }

    // A vault is listed only over the canonical token for this chain, the
    // same answer the token Conditions use.
    const registryAsset = await tokenFact;
    const canonical = canonicalAddressFor(
      lookup.chainId,
      vault.symbol,
      registryAsset === undefined ? { now } : { now, registryAsset }
    );
    if (
      canonical === undefined ||
      canonical.address.toLowerCase() !== row.asset
    ) {
      return undefined;
    }

    const rpcUrl = deps.rpcUrlFor(row.chainNumber);
    const liveReadAt = deps.now();
    const calls: RpcCall[] = [
      { id: 1, method: "eth_getCode", params: [row.contractAddress, LATEST] },
      {
        id: 2,
        method: "eth_getStorageAt",
        params: [row.contractAddress, SLOT_EIP1967, LATEST],
      },
      {
        id: 3,
        method: "eth_call",
        params: [{ to: row.contractAddress, data: ASSET_SELECTOR }, LATEST],
      },
      { id: 4, method: "eth_blockNumber", params: [] },
    ];
    if (vault.amount !== undefined) {
      calls.push({
        id: 5,
        method: "eth_call",
        params: [
          {
            to: row.contractAddress,
            data: `${PREVIEW_DEPOSIT_SELECTOR}${vault.amount
              .toString(16)
              .padStart(64, "0")}`,
          },
          LATEST,
        ],
      });
    }
    if (row.implementation) {
      calls.push({
        id: 6,
        method: "eth_getCode",
        params: [row.implementation.address, LATEST],
      });
    }

    let results = new Map<number, unknown>();
    if (rpcUrl !== undefined) {
      const reply = await within(deadlineAt, controller, () =>
        postBatch(rpcUrl, calls, deps, controller)
      );
      results = parseBatch(reply === TIMED_OUT ? undefined : reply, calls);
    }

    const previewWord = wordOf(results.get(5));
    const blockNumber = blockOf(results.get(4));
    return {
      chainId: lookup.chainId,
      contractAddress: row.contractAddress,
      asset: row.asset,
      upgradeable: row.upgradeable,
      ...(row.implementation ? { implementation: row.implementation } : {}),
      expiresAt: row.expiresAt,
      vaultCodeHash: compareHash(results.get(1), row.codeSha256),
      implementationSlot: wordOf(results.get(2)) ?? "unread",
      ...(row.implementation
        ? {
            implementationCodeHash: compareHash(
              results.get(6),
              row.implementation.codeSha256
            ),
          }
        : {}),
      assetRead: addressOfWord(wordOf(results.get(3))) ?? "unread",
      preview:
        previewWord === undefined
          ? { failed: true }
          : { shares: BigInt(previewWord).toString() },
      ...(blockNumber !== undefined ? { blockNumber } : {}),
      liveReadAt,
    };
  } catch {
    return undefined;
  }
}

// --- the entry --------------------------------------------------------------

export async function gatherRegistry(
  request: unknown,
  deps: RegistryDeps
): Promise<RegistryFacts> {
  try {
    const lookup = readLookup(request);
    if (!lookup) {
      return {};
    }
    const config = deps.registry();
    const keys = config ? readKeys(deps.keys) : undefined;
    if (!config || !keys) {
      return {};
    }
    const tokenFact =
      lookup.tokenSymbol !== undefined
        ? readTokenFact(
            { ...lookup, tokenSymbol: lookup.tokenSymbol },
            deps,
            config,
            keys
          )
        : Promise.resolve(undefined);
    const vaultFact =
      lookup.vault !== undefined
        ? readVaultFact(
            { ...lookup, vault: lookup.vault },
            deps,
            config,
            keys,
            tokenFact
          )
        : Promise.resolve(undefined);
    const [registryAsset, registryVault] = await Promise.all([
      tokenFact,
      vaultFact,
    ]);
    return {
      ...(registryAsset !== undefined ? { registryAsset } : {}),
      ...(registryVault !== undefined ? { registryVault } : {}),
    };
  } catch {
    return {};
  }
}
