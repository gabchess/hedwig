import { PublicKey } from "@solana/web3.js";
import {
  solanaCaptureContextForProfile,
  type CapturedSolanaProposal,
  type SolanaBindingContext,
} from "./solana-proposal";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DECODER =
  "https://github.com/solana-labs/solana-program-library/blob/b1c44c171bc95e6ee74af12365cb9cbab68be76c/token/program/src/state.rs";
const MAX_BYTES = 256 * 1024;
const MAX_AGE_MS = 60_000;
export type SolanaProfile =
  | "solana-invalid-deposit-v1"
  | "solana-native-usdc-swap-v1";
export type SolanaProfileCode =
  | "INVALID_DEPOSIT_PROGRAM"
  | "CAPTURE_INVALID"
  | "POLICY_INVALID"
  | "OBSERVATIONS_INVALID"
  | "OBSERVATIONS_UNAVAILABLE"
  | "PROGRAM_UNBOUND"
  | "MINT_DATA_UNAVAILABLE"
  | "POSITIVE_ROUTE_UNQUALIFIED";
export interface SolanaProfilePolicy {
  readonly version: 1;
  readonly profile: SolanaProfile;
  readonly chainId: "solana:mainnet";
  readonly expectedGenesisHash: string;
  readonly sourceId: string;
  readonly canonicalUsdcMint: typeof USDC;
  readonly classicTokenProgram: typeof TOKEN;
  readonly authorizedFeePayer: string;
  readonly authorizedRecipient: string;
}
export type SolanaProfileAccountObservation =
  | {
      readonly address: string;
      readonly status: "found";
      readonly ownerProgram: string;
      readonly executable: boolean;
      readonly lamports: string;
      readonly dataBase64: string;
      readonly slot: number;
      readonly observedAtMs: number;
    }
  | {
      readonly address: string;
      readonly status: "missing";
      readonly slot: number;
      readonly observedAtMs: number;
    }
  | { readonly address: string; readonly status: "unavailable" };
// Configured process observations, never LLM arguments. Every raw account read
// remains request-local. The transport binds its actual context and source.
export interface SolanaProfileObservations {
  readonly version: 1;
  readonly requestDigest: string;
  readonly messageDigest: string;
  readonly bindingContext: SolanaBindingContext;
  readonly commitment: "confirmed";
  readonly accounts: readonly SolanaProfileAccountObservation[];
}
export interface SolanaProfileCheck {
  readonly id:
    | "capture-bound"
    | "network-bound"
    | "program-matches-intent"
    | "program-is-executable"
    | "mint-is-canonical";
  readonly status: "verified" | "mismatch" | "unavailable";
}
export interface SolanaInvalidProgramFacts {
  readonly chainId: "solana:mainnet";
  readonly assetMint: typeof USDC;
  readonly programAddress: typeof USDC;
  readonly ownerProgram: typeof TOKEN;
  readonly executable: false;
  readonly mintInitialized: true;
  readonly mintDecimals: 6;
  readonly decoderSource: typeof DECODER;
  readonly observedAtMs: number;
  readonly slot: number;
  readonly commitment: "confirmed";
}
export interface SolanaProfileResult {
  readonly version: 1;
  readonly profile: SolanaProfile | null;
  readonly requestDigest: string | null;
  readonly messageDigest: string | null;
  readonly disposition: "deny" | "unavailable" | "eligible";
  readonly code: SolanaProfileCode;
  readonly checks: readonly SolanaProfileCheck[];
  readonly facts: SolanaInvalidProgramFacts | null;
}
const own = (v: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(v, key);
const integer = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
function closed(v: any, fields: readonly string[]): boolean {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v).length === fields.length &&
    fields.every((k) => own(v, k))
  );
}
function pubkey(v: unknown): v is string {
  try {
    return (
      typeof v === "string" &&
      v.length <= 44 &&
      new PublicKey(v).toBase58() === v
    );
  } catch {
    return false;
  }
}
function freeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
// Bound own-data traversal before decoding. Accessors, cycles, exotic objects,
// sparse arrays and surplus fields supply no observations.
function snapshot(input: unknown): any {
  let nodes = 0,
    bytes = 0;
  const count = (n: number) => {
    bytes += n;
    if (bytes > MAX_BYTES) throw new Error("bounded");
  };
  const copy = (v: unknown, depth: number): any => {
    if (++nodes > 4096 || depth > 8) throw new Error("bounded");
    count(1);
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      count(Buffer.byteLength(v));
      return v;
    }
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v !== "object") throw new Error("own data required");
    const array = Array.isArray(v);
    if (
      ![array ? Array.prototype : Object.prototype, null].includes(
        Object.getPrototypeOf(v)
      )
    )
      throw new Error("own data required");
    const names = Reflect.ownKeys(v);
    if (
      array &&
      ((v as any).length > 4096 || names.length !== (v as any).length + 1)
    )
      throw new Error("bounded");
    const out: any = array ? [] : Object.create(null);
    for (const name of names) {
      if (array && name === "length") continue;
      const field = Object.getOwnPropertyDescriptor(v, name);
      if (
        typeof name !== "string" ||
        !field?.enumerable ||
        !own(field, "value") ||
        (array &&
          (!/^(0|[1-9][0-9]*)$/.test(name) ||
            Number(name) >= (v as any).length))
      )
        throw new Error("own data required");
      if (!array) count(Buffer.byteLength(name));
      out[name] = copy(field.value, depth + 1);
    }
    return out;
  };
  const result = copy(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES)
    throw new Error("bounded");
  return freeze(result);
}
function validPolicy(
  p: any,
  c: SolanaBindingContext,
  profile: SolanaProfile
): boolean {
  return (
    closed(p, [
      "version",
      "profile",
      "chainId",
      "expectedGenesisHash",
      "sourceId",
      "canonicalUsdcMint",
      "classicTokenProgram",
      "authorizedFeePayer",
      "authorizedRecipient",
    ]) &&
    p.version === 1 &&
    p.profile === profile &&
    p.chainId === "solana:mainnet" &&
    p.expectedGenesisHash === GENESIS &&
    c.expectedGenesisHash === GENESIS &&
    p.sourceId === c.sourceId &&
    p.canonicalUsdcMint === USDC &&
    p.classicTokenProgram === TOKEN &&
    p.authorizedFeePayer === c.owner &&
    pubkey(p.authorizedRecipient)
  );
}
function validAccount(
  row: any,
  c: SolanaBindingContext,
  nowMs: number
): boolean {
  if (!row || !pubkey(row.address)) return false;
  if (row.status === "unavailable") return closed(row, ["address", "status"]);
  if (
    !["found", "missing"].includes(row.status) ||
    !integer(row.slot) ||
    row.slot < c.slot ||
    !integer(row.observedAtMs) ||
    row.observedAtMs < c.observedAtMs ||
    row.observedAtMs > nowMs ||
    nowMs - row.observedAtMs > MAX_AGE_MS
  )
    return false;
  if (row.status === "missing")
    return closed(row, ["address", "status", "slot", "observedAtMs"]);
  return (
    closed(row, [
      "address",
      "status",
      "ownerProgram",
      "executable",
      "lamports",
      "dataBase64",
      "slot",
      "observedAtMs",
    ]) &&
    pubkey(row.ownerProgram) &&
    typeof row.executable === "boolean" &&
    typeof row.dataBase64 === "string" &&
    typeof row.lamports === "string" &&
    /^(0|[1-9][0-9]{0,19})$/.test(row.lamports) &&
    BigInt(row.lamports) < 1n << 64n
  );
}
function initializedUsdcMint(dataBase64: string): boolean {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      dataBase64
    )
  )
    return false;
  const data = Buffer.from(dataBase64, "base64");
  // Pinned official classic SPL Mint layout. COption None ignores its body.
  return (
    data.length === 82 &&
    data.toString("base64") === dataBase64 &&
    [0, 1].includes(data.readUInt32LE(0)) &&
    [0, 1].includes(data.readUInt32LE(46)) &&
    data[45] === 1 &&
    data[44] === 6
  );
}
// Pure evidence adapter. This revision proves only the controlled invalid
// deposit program. Complete positive route/effect coverage remains required.
// A disposition carries no score, signing permission or broadcast side effect.
export function evaluateSolanaProfile(
  capture: CapturedSolanaProposal,
  trustedObservations: SolanaProfileObservations | null | undefined,
  trustedPolicy: SolanaProfilePolicy,
  nowMs = Date.now()
): SolanaProfileResult {
  let profile: SolanaProfile | null = null,
    requestDigest: string | null = null,
    messageDigest: string | null = null;
  const checks: SolanaProfileCheck[] = [];
  const unavailable = (code: SolanaProfileCode): SolanaProfileResult =>
    freeze({
      version: 1,
      profile,
      requestDigest,
      messageDigest,
      disposition: "unavailable",
      code,
      checks: [...checks],
      facts: null,
    });
  let original: SolanaBindingContext;
  try {
    original = solanaCaptureContextForProfile(capture);
  } catch {
    return unavailable("CAPTURE_INVALID");
  }
  requestDigest = capture.requestDigest;
  messageDigest = capture.messageDigest;
  profile =
    capture.request.action === "deposit"
      ? "solana-invalid-deposit-v1"
      : "solana-native-usdc-swap-v1";
  checks.push({ id: "capture-bound", status: "verified" });
  let p: any;
  try {
    p = snapshot(trustedPolicy);
    if (!validPolicy(p, original, profile))
      return unavailable("POLICY_INVALID");
  } catch {
    return unavailable("POLICY_INVALID");
  }
  if (trustedObservations == null)
    return unavailable("OBSERVATIONS_UNAVAILABLE");
  let o: any, context: SolanaBindingContext;
  try {
    o = snapshot(trustedObservations);
    if (
      !integer(nowMs) ||
      !closed(o, [
        "version",
        "requestDigest",
        "messageDigest",
        "bindingContext",
        "commitment",
        "accounts",
      ]) ||
      o.version !== 1 ||
      o.requestDigest !== requestDigest ||
      o.messageDigest !== messageDigest ||
      o.commitment !== "confirmed" ||
      !Array.isArray(o.accounts) ||
      o.accounts.length > 1
    )
      return unavailable("OBSERVATIONS_INVALID");
    context = solanaCaptureContextForProfile(capture, o.bindingContext, nowMs);
    if (!o.accounts.every((r: any) => validAccount(r, context, nowMs)))
      return unavailable("OBSERVATIONS_INVALID");
  } catch {
    return unavailable("OBSERVATIONS_INVALID");
  }
  checks.push({ id: "network-bound", status: "verified" });
  if (profile === "solana-native-usdc-swap-v1")
    return unavailable("POSITIVE_ROUTE_UNQUALIFIED");
  const intent = capture.request.solanaIntent,
    instruction = capture.instructions[0];
  // These labels only constrain the selected fixture. They never establish
  // decoded token movement or a conclusive output/recipient mismatch.
  if (
    capture.instructions.length !== 1 ||
    instruction.programId !== USDC ||
    instruction.programId !== intent.claimedProgram ||
    intent.assetMint !== USDC ||
    intent.recipient !== p.authorizedRecipient ||
    instruction.accounts.length !== 0 ||
    instruction.dataBase64 !== ""
  )
    return unavailable("PROGRAM_UNBOUND");
  const account = o.accounts[0];
  if (!account || account.status !== "found")
    return unavailable("OBSERVATIONS_UNAVAILABLE");
  if (
    account.address !== instruction.programId ||
    account.ownerProgram !== TOKEN ||
    account.executable !== false
  )
    return unavailable("PROGRAM_UNBOUND");
  checks.push({ id: "program-matches-intent", status: "verified" });
  if (!initializedUsdcMint(account.dataBase64))
    return unavailable("MINT_DATA_UNAVAILABLE");
  checks.push(
    { id: "mint-is-canonical", status: "verified" },
    { id: "program-is-executable", status: "mismatch" }
  );
  return freeze({
    version: 1,
    profile,
    requestDigest,
    messageDigest,
    disposition: "deny",
    code: "INVALID_DEPOSIT_PROGRAM",
    checks,
    facts: {
      chainId: "solana:mainnet",
      assetMint: USDC,
      programAddress: USDC,
      ownerProgram: TOKEN,
      executable: false,
      mintInitialized: true,
      mintDecimals: 6,
      decoderSource: DECODER,
      observedAtMs: account.observedAtMs,
      slot: account.slot,
      commitment: "confirmed",
    },
  });
}
