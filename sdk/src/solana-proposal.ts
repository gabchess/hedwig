import { createHash, createPublicKey, verify } from "node:crypto";
import {
  AddressLookupTableProgram,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  type VersionedMessage,
} from "@solana/web3.js";

// Caller-side mechanics only. Trusted caller dependencies supply observations
// and validated assessment data. No network, key custody or broadcaster lives
// here. Complete requests and artifacts remain in bounded request memory.
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_TRANSACTION_BYTES = 1232;
const MAX_FACT_AGE_MS = 60_000;
const ACTIVE_TABLE_SLOT = "18446744073709551615";
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const captured = new WeakMap<CapturedSolanaProposal, SolanaBindingContext>();

type Data = Record<string, any>;
export interface SolanaProposalRequest {
  readonly chainId: "solana:mainnet";
  readonly action: "swap" | "deposit";
  readonly transaction: { readonly encoding: "base64"; readonly bytes: string };
  readonly solanaIntent: Readonly<Record<string, string | number>>;
  readonly question?: string;
}
export interface SolanaAddressTableObservation {
  readonly address: string;
  readonly owner: string;
  readonly observedAtMs: number;
  readonly slot: number;
  readonly deactivationSlot: string;
  readonly lastExtendedSlot: number;
  readonly lastExtendedSlotStartIndex: number;
  readonly addresses: readonly string[];
}
// This context belongs to trusted caller configuration and read transport,
// never to LLM tool arguments. Use the full configured genesis hash pin.
export interface SolanaBindingContext {
  readonly owner: string;
  readonly expectedGenesisHash: string;
  readonly observedGenesisHash: string;
  readonly sourceId: string;
  readonly observedAtMs: number;
  readonly slot: number;
  readonly currentBlockHeight: number;
  readonly lastValidBlockHeight: number;
  readonly quoteId: string;
  readonly blockhash: string;
  readonly quoteExpiresAtMs: number;
  readonly addressTables: readonly SolanaAddressTableObservation[];
}
interface LookupBinding {
  readonly address: string;
  readonly owner: string;
  readonly slot: number;
  readonly observedAtMs: number;
  readonly writable: readonly {
    readonly index: number;
    readonly address: string;
  }[];
  readonly readonly: readonly {
    readonly index: number;
    readonly address: string;
  }[];
}
export interface CapturedSolanaProposal {
  readonly request: SolanaProposalRequest;
  readonly requestDigest: string;
  readonly messageDigest: string;
  readonly messageBase64: string;
  readonly proposalBase64: string;
  readonly version: "legacy" | 0;
  readonly feePayer: string;
  readonly instructions: readonly {
    readonly programId: string;
    readonly accounts: readonly {
      readonly address: string;
      readonly isSigner: boolean;
      readonly isWritable: boolean;
    }[];
    readonly dataBase64: string;
  }[];
  readonly addressTableBindings: readonly LookupBinding[];
}
export interface VerifiedSolanaArtifact {
  readonly transactionBase64: string;
  readonly messageDigest: string;
  readonly requestDigest: string;
  readonly signature: string;
}
// Separate from the hosted wire. The production adapter must validate the
// complete response before projecting this receipt, bind its original reference
// to this request, and derive messageDigest from this same captured proposal.
// Arbitrary approval data supplies no assessment evidence.
export interface SolanaAssessmentBinding {
  readonly requestDigest: string;
  readonly messageDigest: string;
  readonly verdict: "ALLOW_UNDER_POLICY" | "DENY" | "UNKNOWN";
  readonly proceed: boolean;
  readonly score: number;
  readonly expiresAtMs: number;
}
export interface SolanaPreSignGuardInput {
  readonly proposal: unknown;
  readonly context: SolanaBindingContext;
  readonly assess: (
    proposal: CapturedSolanaProposal
  ) => Promise<SolanaAssessmentBinding>;
  readonly refreshContext: (
    proposal: CapturedSolanaProposal
  ) => Promise<SolanaBindingContext>;
  readonly sign: (proposal: CapturedSolanaProposal) => Promise<string>;
  readonly now?: () => number;
  // Bounds each caller dependency, including human signing. The caller may
  // select a longer human wait; quote/reference expiry always bounds it first.
  // This value never changes the separate backend assessment deadline.
  readonly dependencyDeadlineMs?: number;
}
export interface SolanaPreSignGuardResult {
  readonly status: "held" | "signed";
  readonly signerOutcome: "not-attempted" | "settled" | "unknown";
  readonly code?: string;
  readonly artifact?: VerifiedSolanaArtifact;
}

function fail(code: string): never {
  throw new Error(code);
}
const own = (v: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(v, key);
const integer = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;
function keys(v: any, required: string[], optional: string[] = []): v is Data {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    required.every((k) => own(v, k)) &&
    Object.keys(v).every((k) => [...required, ...optional].includes(k))
  );
}
function freeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
// Capture own data once without running accessors or toJSON. Bound traversal
// before serialization, including cycles, exotic objects and sparse arrays.
function snapshot(v: unknown, maxBytes: number): any {
  let nodes = 0,
    countedBytes = 0;
  const count = (bytes: number) => {
    countedBytes += bytes;
    if (countedBytes > maxBytes) fail("SOLANA_INPUT_INVALID");
  };
  function copy(item: unknown, depth: number): any {
    if (++nodes > 4096 || depth > 8) fail("SOLANA_INPUT_INVALID");
    count(1);
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      count(Buffer.byteLength(item));
      return item;
    }
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object") fail("SOLANA_INPUT_INVALID");
    const array = Array.isArray(item);
    if (
      ![array ? Array.prototype : Object.prototype, null].includes(
        Object.getPrototypeOf(item)
      )
    )
      fail("SOLANA_INPUT_INVALID");
    const names = Reflect.ownKeys(item as object);
    if (
      array &&
      ((item as any).length > 4096 || names.length !== (item as any).length + 1)
    )
      fail("SOLANA_INPUT_INVALID");
    const out: any = array ? [] : Object.create(null);
    for (const name of names) {
      if (array && name === "length") continue;
      const field = Object.getOwnPropertyDescriptor(item, name);
      if (
        typeof name !== "string" ||
        !field?.enumerable ||
        !own(field, "value") ||
        (array &&
          (!/^(0|[1-9][0-9]*)$/.test(name) ||
            Number(name) >= (item as any).length))
      )
        fail("SOLANA_INPUT_INVALID");
      if (!array) count(Buffer.byteLength(name));
      out[name] = copy(field.value, depth + 1);
    }
    return out;
  }
  const result = copy(v, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
    fail("SOLANA_INPUT_INVALID");
  return freeze(result);
}
function publicKey(v: unknown): v is string {
  try {
    return text(v, 44) && new PublicKey(v).toBase58() === v;
  } catch {
    return false;
  }
}
function amount(v: unknown, positive = false): v is string {
  return (
    typeof v === "string" &&
    /^(0|[1-9][0-9]{0,19})$/.test(v) &&
    BigInt(v) < 1n << 64n &&
    (!positive || v !== "0")
  );
}
function request(v: unknown): SolanaProposalRequest {
  const r = snapshot(v, MAX_REQUEST_BYTES);
  if (
    !keys(
      r,
      ["chainId", "action", "transaction", "solanaIntent"],
      ["question"]
    ) ||
    r.chainId !== "solana:mainnet" ||
    !["swap", "deposit"].includes(r.action) ||
    !keys(r.transaction, ["encoding", "bytes"]) ||
    r.transaction.encoding !== "base64" ||
    (own(r, "question") &&
      (typeof r.question !== "string" || r.question.length > 2000))
  )
    fail("SOLANA_REQUEST_INVALID");
  const i = r.solanaIntent;
  if (r.action === "swap") {
    if (
      !keys(i, [
        "inputKind",
        "inputSymbol",
        "outputMint",
        "inputAmountLamports",
        "quotedOutputAmount",
        "minOutputAmount",
        "recipient",
        "maxSlippageBps",
        "maxFeeLamports",
      ]) ||
      i.inputKind !== "native" ||
      i.inputSymbol !== "SOL" ||
      !publicKey(i.outputMint) ||
      !publicKey(i.recipient) ||
      !amount(i.inputAmountLamports, true) ||
      !amount(i.quotedOutputAmount, true) ||
      !amount(i.minOutputAmount, true) ||
      BigInt(i.minOutputAmount) > BigInt(i.quotedOutputAmount) ||
      !amount(i.maxFeeLamports) ||
      !integer(i.maxSlippageBps) ||
      i.maxSlippageBps > 10000
    )
      fail("SOLANA_REQUEST_INVALID");
  } else if (
    !keys(i, ["assetMint", "amountBaseUnits", "claimedProgram", "recipient"]) ||
    !publicKey(i.assetMint) ||
    !publicKey(i.claimedProgram) ||
    !publicKey(i.recipient) ||
    !amount(i.amountBaseUnits, true)
  )
    fail("SOLANA_REQUEST_INVALID");
  return r as unknown as SolanaProposalRequest;
}
function transaction(base64: unknown): VersionedTransaction {
  try {
    if (
      typeof base64 !== "string" ||
      base64.length > 1644 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        base64
      )
    )
      fail("SOLANA_TRANSACTION_INVALID");
    const raw = Buffer.from(base64, "base64");
    if (
      !raw.length ||
      raw.length > MAX_TRANSACTION_BYTES ||
      raw.toString("base64") !== base64
    )
      fail("SOLANA_TRANSACTION_INVALID");
    const tx = VersionedTransaction.deserialize(raw);
    if (
      (tx.version !== "legacy" && tx.version !== 0) ||
      !Buffer.from(tx.serialize()).equals(raw)
    )
      fail("SOLANA_TRANSACTION_INVALID");
    return tx;
  } catch {
    return fail("SOLANA_TRANSACTION_INVALID");
  }
}
function context(v: unknown, nowMs: number): SolanaBindingContext {
  const c = snapshot(v, MAX_CONTEXT_BYTES);
  if (
    !integer(nowMs) ||
    !keys(c, [
      "owner",
      "expectedGenesisHash",
      "observedGenesisHash",
      "sourceId",
      "observedAtMs",
      "slot",
      "currentBlockHeight",
      "lastValidBlockHeight",
      "quoteId",
      "blockhash",
      "quoteExpiresAtMs",
      "addressTables",
    ]) ||
    !publicKey(c.owner) ||
    !publicKey(c.expectedGenesisHash) ||
    c.observedGenesisHash !== c.expectedGenesisHash ||
    !publicKey(c.blockhash) ||
    !text(c.sourceId, 280) ||
    !text(c.quoteId, 128) ||
    !integer(c.observedAtMs) ||
    c.observedAtMs > nowMs ||
    nowMs - c.observedAtMs > MAX_FACT_AGE_MS ||
    !integer(c.slot) ||
    c.slot === 0 ||
    !integer(c.currentBlockHeight) ||
    !integer(c.lastValidBlockHeight) ||
    !integer(c.quoteExpiresAtMs) ||
    !Array.isArray(c.addressTables)
  )
    fail("SOLANA_CONTEXT_INVALID");
  if (nowMs >= c.quoteExpiresAtMs) fail("SOLANA_QUOTE_EXPIRED");
  if (c.currentBlockHeight > c.lastValidBlockHeight)
    fail("SOLANA_BLOCKHASH_EXPIRED");
  return c as unknown as SolanaBindingContext;
}
function resolve(
  message: VersionedMessage,
  c: SolanaBindingContext
): { addresses: string[]; bindings: LookupBinding[] } {
  const writable: string[] = [],
    readonly: string[] = [],
    bindings: LookupBinding[] = [];
  const lookups = message.addressTableLookups;
  if (c.addressTables.length !== lookups.length) fail("SOLANA_ALT_INVALID");
  const seen = new Set<string>();
  for (const lookup of lookups) {
    const address = lookup.accountKey.toBase58();
    const t = c.addressTables.find((row) => row.address === address);
    if (
      seen.has(address) ||
      !t ||
      !keys(t, [
        "address",
        "owner",
        "observedAtMs",
        "slot",
        "deactivationSlot",
        "lastExtendedSlot",
        "lastExtendedSlotStartIndex",
        "addresses",
      ]) ||
      t.owner !== AddressLookupTableProgram.programId.toBase58() ||
      t.deactivationSlot !== ACTIVE_TABLE_SLOT ||
      !integer(t.slot) ||
      t.slot !== c.slot ||
      !integer(t.observedAtMs) ||
      t.observedAtMs !== c.observedAtMs ||
      !integer(t.lastExtendedSlot) ||
      t.lastExtendedSlot > t.slot ||
      !integer(t.lastExtendedSlotStartIndex) ||
      !Array.isArray(t.addresses) ||
      t.addresses.length > 256 ||
      t.lastExtendedSlotStartIndex > t.addresses.length ||
      !t.addresses.every(publicKey)
    )
      fail("SOLANA_ALT_INVALID");
    seen.add(address);
    const select = (indexes: readonly number[], out: string[]) =>
      Array.from(indexes, (index) => {
        if (
          index >= t.addresses.length ||
          (t.slot === t.lastExtendedSlot &&
            index >= t.lastExtendedSlotStartIndex)
        )
          fail("SOLANA_ALT_INVALID");
        const selected = { index, address: t.addresses[index] };
        out.push(selected.address);
        return selected;
      });
    bindings.push({
      address,
      owner: t.owner,
      slot: t.slot,
      observedAtMs: t.observedAtMs,
      writable: select(lookup.writableIndexes, writable),
      readonly: select(lookup.readonlyIndexes, readonly),
    });
  }
  const addresses = [
    ...message.staticAccountKeys.map((k) => k.toBase58()),
    ...writable,
    ...readonly,
  ];
  if (new Set(addresses).size !== addresses.length || addresses.length > 256)
    fail("SOLANA_ALT_INVALID");
  return { addresses, bindings };
}
function inspect(tx: VersionedTransaction, c: SolanaBindingContext) {
  const m = tx.message,
    h = m.header;
  if (
    h.numRequiredSignatures !== 1 ||
    h.numReadonlySignedAccounts !== 0 ||
    tx.signatures.length !== 1
  )
    fail("SOLANA_SIGNER_UNSUPPORTED");
  if (m.staticAccountKeys[0]?.toBase58() !== c.owner)
    fail("SOLANA_SIGNER_MISMATCH");
  if (m.recentBlockhash !== c.blockhash) fail("SOLANA_BLOCKHASH_MISMATCH");
  if (
    h.numReadonlyUnsignedAccounts > m.staticAccountKeys.length - 1 ||
    m.compiledInstructions.length === 0
  )
    fail("SOLANA_INSTRUCTION_INVALID");
  const { addresses, bindings } = resolve(m, c);
  const instructions = m.compiledInstructions.map((i) => {
    if (
      i.programIdIndex < 1 ||
      i.programIdIndex >= m.staticAccountKeys.length ||
      m.isAccountWritable(i.programIdIndex)
    )
      fail("SOLANA_INSTRUCTION_INVALID");
    const programId = addresses[i.programIdIndex];
    if (
      programId === SystemProgram.programId.toBase58() &&
      i.data.length >= 4 &&
      Buffer.from(i.data).readUInt32LE(0) === 4
    )
      fail("SOLANA_NONCE_UNSUPPORTED");
    return {
      programId,
      dataBase64: Buffer.from(i.data).toString("base64"),
      accounts: Array.from(i.accountKeyIndexes, (index) => {
        if (index >= addresses.length) fail("SOLANA_INSTRUCTION_INVALID");
        return {
          address: addresses[index],
          isSigner: m.isAccountSigner(index),
          isWritable: m.isAccountWritable(index),
        };
      }),
    };
  });
  return { bindings, instructions };
}
function ordered(v: any): any {
  if (Array.isArray(v)) return v.map(ordered);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, ordered(v[k])])
    );
  return v;
}
const hash = (v: Uint8Array | string) =>
  createHash("sha256").update(v).digest("hex");

export function captureSolanaProposal(
  input: unknown,
  observed: SolanaBindingContext,
  nowMs = Date.now()
): CapturedSolanaProposal {
  const r = request(input),
    c = context(observed, nowMs),
    tx = transaction(r.transaction.bytes);
  const { bindings, instructions } = inspect(tx, c);
  if (tx.signatures.some((s) => s.some((byte) => byte !== 0)))
    fail("SOLANA_PROPOSAL_SIGNED");
  const message = Buffer.from(tx.message.serialize());
  const result: CapturedSolanaProposal = freeze({
    request: r,
    requestDigest: hash(JSON.stringify(ordered({ version: 1, request: r }))),
    messageDigest: hash(message),
    messageBase64: message.toString("base64"),
    proposalBase64: r.transaction.bytes,
    version: tx.version,
    feePayer: c.owner,
    instructions,
    addressTableBindings: bindings,
  });
  captured.set(result, c);
  return result;
}
function unchanged(
  capture: CapturedSolanaProposal,
  observed: SolanaBindingContext,
  nowMs: number
): SolanaBindingContext {
  const original = captured.get(capture);
  if (!original) fail("SOLANA_CAPTURE_INVALID");
  const c = context(observed, nowMs);
  for (const field of [
    "owner",
    "expectedGenesisHash",
    "sourceId",
    "quoteId",
    "blockhash",
    "lastValidBlockHeight",
    "quoteExpiresAtMs",
  ] as const) {
    if (c[field] !== original[field]) fail("SOLANA_CONTEXT_CHANGED");
  }
  if (
    c.slot < original.slot ||
    c.currentBlockHeight < original.currentBlockHeight
  )
    fail("SOLANA_CONTEXT_CHANGED");
  const next = resolve(transaction(capture.proposalBase64).message, c).bindings;
  const selected = (rows: readonly LookupBinding[]) =>
    rows.map(({ address, owner, writable, readonly }) => ({
      address,
      owner,
      writable,
      readonly,
    }));
  if (
    JSON.stringify(selected(next)) !==
    JSON.stringify(selected(capture.addressTableBindings))
  )
    fail("SOLANA_ALT_CHANGED");
  return c;
}
function base58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading++;
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex")),
    result = "";
  while (n > 0n) {
    result = alphabet[Number(n % 58n)] + result;
    n /= 58n;
  }
  return "1".repeat(leading) + result;
}
export function verifySolanaSignedArtifact(
  capture: CapturedSolanaProposal,
  artifact: string,
  observed: SolanaBindingContext,
  nowMs = Date.now()
): VerifiedSolanaArtifact {
  unchanged(capture, observed, nowMs);
  const tx = transaction(artifact),
    message = Buffer.from(tx.message.serialize());
  if (message.toString("base64") !== capture.messageBase64)
    fail("SOLANA_MESSAGE_CHANGED");
  const key = createPublicKey({
    key: Buffer.concat([
      ED25519_SPKI,
      new PublicKey(capture.feePayer).toBuffer(),
    ]),
    format: "der",
    type: "spki",
  });
  if (
    tx.signatures.length !== 1 ||
    !verify(null, message, key, tx.signatures[0])
  )
    fail("SOLANA_SIGNATURE_INVALID");
  return freeze({
    transactionBase64: artifact,
    messageDigest: capture.messageDigest,
    requestDigest: capture.requestDigest,
    signature: base58(tx.signatures[0]),
  });
}
function receipt(
  input: unknown,
  capture: CapturedSolanaProposal,
  nowMs: number
): SolanaAssessmentBinding {
  const r = snapshot(input, MAX_REQUEST_BYTES);
  if (
    !integer(nowMs) ||
    !keys(r, [
      "requestDigest",
      "messageDigest",
      "verdict",
      "proceed",
      "score",
      "expiresAtMs",
    ]) ||
    r.requestDigest !== capture.requestDigest ||
    r.messageDigest !== capture.messageDigest ||
    !["ALLOW_UNDER_POLICY", "DENY", "UNKNOWN"].includes(r.verdict) ||
    r.proceed !== (r.verdict === "ALLOW_UNDER_POLICY") ||
    typeof r.score !== "number" ||
    !Number.isFinite(r.score) ||
    r.score < 0 ||
    r.score > 1 ||
    (r.verdict === "DENY" && r.score !== 0) ||
    (r.verdict === "UNKNOWN" && r.score >= 0.8) ||
    (r.verdict === "ALLOW_UNDER_POLICY" && r.score < 0.8) ||
    !integer(r.expiresAtMs)
  )
    fail("SOLANA_ASSESSMENT_INVALID");
  if (nowMs >= r.expiresAtMs) fail("SOLANA_ASSESSMENT_EXPIRED");
  if (r.verdict !== "ALLOW_UNDER_POLICY") fail("SOLANA_ASSESSMENT_REFUSED");
  return r as unknown as SolanaAssessmentBinding;
}
async function bounded<T>(
  fn: () => Promise<T>,
  ms: number,
  before: () => void
): Promise<T> {
  const started = performance.now();
  const timeout = new Error("SOLANA_DEPENDENCY_TIMEOUT");
  const assertInTime = () => {
    if (performance.now() - started >= ms) throw timeout;
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeout), ms);
    Promise.resolve()
      .then(() => {
        assertInTime();
        before();
        assertInTime();
        // Only dependency failures are masked. These trusted pre-effect checks
        // retain their reason so the caller can replace an expired proposal.
        try {
          return Promise.resolve(fn()).catch(() => {
            throw new Error("SOLANA_DEPENDENCY_FAILED");
          });
        } catch {
          throw new Error("SOLANA_DEPENDENCY_FAILED");
        }
      })
      .then(
        (value) => {
          clearTimeout(timer);
          if (performance.now() - started >= ms) reject(timeout);
          else resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
  });
}
// External caller guard. Functions are trusted process dependencies. Only the
// captured proposal reaches sign, at most once. A held result has no artifact.
export async function runSolanaPreSignGuard(
  input: SolanaPreSignGuardInput
): Promise<SolanaPreSignGuardResult> {
  let signerOutcome: SolanaPreSignGuardResult["signerOutcome"] =
    "not-attempted";
  try {
    const now = input.now ?? Date.now;
    const deadline = input.dependencyDeadlineMs ?? 5000;
    if (!integer(deadline) || deadline < 1 || deadline > 2147483647)
      fail("SOLANA_DEADLINE_INVALID");
    const capture = captureSolanaProposal(input.proposal, input.context, now());
    const original = captured.get(capture)!;
    const { assess, refreshContext, sign } = input;
    let expiresAtMs = original.quoteExpiresAtMs;
    const live = () => {
      const time = now();
      if (!integer(time)) fail("SOLANA_CONTEXT_INVALID");
      if (time >= original.quoteExpiresAtMs) fail("SOLANA_QUOTE_EXPIRED");
      if (time >= expiresAtMs) fail("SOLANA_ASSESSMENT_EXPIRED");
      return time;
    };
    const call = <T>(fn: () => Promise<T>, before?: () => void) => {
      const time = live();
      return bounded(fn, Math.min(deadline, expiresAtMs - time), () => {
        live();
        before?.();
      });
    };
    const assessed = receipt(await call(() => assess(capture)), capture, now());
    expiresAtMs = Math.min(expiresAtMs, assessed.expiresAtMs);
    const refreshed = await call(() => refreshContext(capture));
    unchanged(capture, refreshed, now());
    receipt(assessed, capture, now());
    const artifact = await call(
      () => {
        signerOutcome = "unknown";
        return sign(capture);
      },
      () => {
        unchanged(capture, refreshed, now());
        receipt(assessed, capture, now());
      }
    );
    signerOutcome = "settled";
    receipt(assessed, capture, now());
    const finalContext = await call(() => refreshContext(capture));
    const verified = verifySolanaSignedArtifact(
      capture,
      artifact,
      finalContext,
      now()
    );
    receipt(assessed, capture, now());
    return freeze({ status: "signed", signerOutcome, artifact: verified });
  } catch (error) {
    let code = "SOLANA_GUARD_FAILED";
    try {
      if (error instanceof Error && /^SOLANA_[A-Z_]+$/.test(error.message))
        code = error.message;
    } catch {
      /* fixed code */
    }
    return freeze({ status: "held", signerOutcome, code });
  }
}
