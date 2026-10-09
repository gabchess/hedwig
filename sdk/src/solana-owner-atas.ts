import { PublicKey } from "@solana/web3.js";
import {
  solanaCaptureContextForProfile,
  type CapturedSolanaProposal,
  type SolanaBindingContext,
} from "./solana-proposal";
import { type SolanaProfileObservations } from "./solana-profile";
import {
  decodeClassicSolanaTokenAccount,
  type ClassicSolanaTokenAccount,
} from "./solana-token-account";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DERIVATION =
  "https://github.com/solana-labs/solana-program-library/blob/b1c44c171bc95e6ee74af12365cb9cbab68be76c/associated-token-account/program/src/lib.rs";
const ENVELOPE = [
  "version",
  "requestDigest",
  "messageDigest",
  "bindingContext",
  "commitment",
  "accounts",
] as const;
const ACCOUNT = [
  "address",
  "status",
  "ownerProgram",
  "executable",
  "lamports",
  "dataBase64",
  "slot",
  "observedAtMs",
] as const;

export interface SolanaOwnerAtaAccountFacts extends ClassicSolanaTokenAccount {
  readonly address: string;
  readonly lamports: string;
  readonly slot: number;
  readonly observedAtMs: number;
}
// Request-local identity facts only. A writable reference establishes no swap,
// transfer, initialized-account permission, rent, fee or cleanup coverage.
export interface SolanaOwnerAtaFacts {
  readonly version: 1;
  readonly requestDigest: string;
  readonly messageDigest: string;
  readonly owner: string;
  readonly sourceId: string;
  readonly expectedGenesisHash: typeof GENESIS;
  readonly commitment: "confirmed";
  readonly derivationSource: typeof DERIVATION;
  readonly wsol: SolanaOwnerAtaAccountFacts;
  readonly usdc: SolanaOwnerAtaAccountFacts;
}
function fail(code = "SOLANA_OWNER_ATA_INPUT_INVALID"): never {
  throw new Error(code);
}
const integer = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
// Capture only a closed set of own data fields. All raw strings have fixed
// bounds below; S1 separately bounds the complete fresh context and ALT data.
function fields(
  input: unknown,
  names: readonly string[],
  array = false
): Record<string, unknown> {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) !== array ||
      ![array ? Array.prototype : Object.prototype, null].includes(
        Object.getPrototypeOf(input)
      )
    )
      fail();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== names.length ||
      keys.some((key) => typeof key !== "string" || !names.includes(key))
    )
      fail();
    const result: Record<string, unknown> = Object.create(null);
    for (const name of names) {
      const field = descriptors[name];
      if (
        !field ||
        field.enumerable !== (name !== "length" || !array) ||
        !Object.prototype.hasOwnProperty.call(field, "value")
      )
        fail();
      result[name] = field.value;
    }
    return result;
  } catch {
    // Unknown proxy errors supply no error properties or caller messages.
    fail();
  }
}
function account(
  input: unknown,
  c: SolanaBindingContext,
  nowMs: number
): Record<string, unknown> {
  const row = fields(input, ACCOUNT);
  if (
    row.status !== "found" ||
    typeof row.address !== "string" ||
    row.address.length > 44 ||
    row.ownerProgram !== TOKEN ||
    row.executable !== false ||
    typeof row.dataBase64 !== "string" ||
    row.dataBase64.length !== 220 ||
    typeof row.lamports !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(row.lamports) ||
    BigInt(row.lamports) >= 1n << 64n ||
    !integer(row.slot) ||
    row.slot < c.slot ||
    !integer(row.observedAtMs) ||
    row.observedAtMs < c.observedAtMs ||
    row.observedAtMs > nowMs ||
    nowMs - row.observedAtMs > 60_000
  )
    fail();
  return row;
}
function derived(owner: string, mint: string): string {
  // Pinned lib.rs uses wallet/tokenProgram/mint, in this exact seed order.
  return PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBuffer(),
      new PublicKey(TOKEN).toBuffer(),
      new PublicKey(mint).toBuffer(),
    ],
    new PublicKey(ATA)
  )[0].toBase58();
}
function reference(capture: CapturedSolanaProposal, address: string): void {
  let present = false;
  for (const ix of capture.instructions) {
    const refs = ix.accounts.filter((a) => a.address === address);
    if (refs.length > 1 || refs.some((a) => a.isSigner || !a.isWritable))
      fail("SOLANA_OWNER_ATA_REFERENCE_INVALID");
    present ||= refs.length === 1;
  }
  if (!present) fail("SOLANA_OWNER_ATA_REFERENCE_INVALID");
}
function decoded(
  row: Record<string, unknown>,
  mint: string,
  owner: string
): SolanaOwnerAtaAccountFacts {
  return Object.freeze({
    ...decodeClassicSolanaTokenAccount({
      ownerProgram: TOKEN,
      executable: false,
      dataBase64: row.dataBase64 as string,
      expectedMint: mint,
      expectedOwner: owner,
    }),
    address: row.address as string,
    lamports: row.lamports as string,
    slot: row.slot as number,
    observedAtMs: row.observedAtMs as number,
  });
}

// Trusted process observations only, never LLM tool arguments. This seam does
// not alter evaluateSolanaProfile or make the positive route eligible.
export function verifySolanaOwnerAtas(
  capture: CapturedSolanaProposal,
  trustedObservations: SolanaProfileObservations,
  nowMs = Date.now()
): SolanaOwnerAtaFacts {
  try {
    solanaCaptureContextForProfile(capture);
  } catch {
    fail("SOLANA_OWNER_ATA_CAPTURE_INVALID");
  }
  const o = fields(trustedObservations, ENVELOPE);
  if (
    o.version !== 1 ||
    o.requestDigest !== capture.requestDigest ||
    o.messageDigest !== capture.messageDigest ||
    o.commitment !== "confirmed"
  )
    fail();
  let context: SolanaBindingContext;
  try {
    // undefined selects S1's internal cached-context lookup, not revalidation.
    if (!integer(nowMs) || o.bindingContext == null)
      fail("SOLANA_OWNER_ATA_CONTEXT_INVALID");
    context = solanaCaptureContextForProfile(
      capture,
      o.bindingContext as SolanaBindingContext,
      nowMs
    );
    if (context.expectedGenesisHash !== GENESIS)
      fail("SOLANA_OWNER_ATA_CONTEXT_INVALID");
  } catch {
    fail("SOLANA_OWNER_ATA_CONTEXT_INVALID");
  }
  const rows = fields(o.accounts, ["0", "1", "length"], true);
  if (rows.length !== 2) fail();
  const accounts = [
    account(rows[0], context, nowMs),
    account(rows[1], context, nowMs),
  ];
  if (accounts[0].address === accounts[1].address) fail();
  const wsolAddress = derived(context.owner, WSOL);
  const usdcAddress = derived(context.owner, USDC);
  const wsol = accounts.find((row) => row.address === wsolAddress);
  const usdc = accounts.find((row) => row.address === usdcAddress);
  if (!wsol || !usdc) fail("SOLANA_OWNER_ATA_ADDRESS_MISMATCH");
  reference(capture, wsolAddress);
  reference(capture, usdcAddress);
  return Object.freeze({
    version: 1,
    requestDigest: capture.requestDigest,
    messageDigest: capture.messageDigest,
    owner: context.owner,
    sourceId: context.sourceId,
    expectedGenesisHash: GENESIS,
    commitment: "confirmed",
    derivationSource: DERIVATION,
    wsol: decoded(wsol, WSOL, context.owner),
    usdc: decoded(usdc, USDC, context.owner),
  });
}
