import { PublicKey } from "@solana/web3.js";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOURCE =
  "https://github.com/solana-labs/solana-program-library/blob/b1c44c171bc95e6ee74af12365cb9cbab68be76c/token/program/src/state.rs";
const FIELDS = [
  "ownerProgram",
  "executable",
  "dataBase64",
  "expectedMint",
  "expectedOwner",
] as const;

export interface ClassicSolanaTokenAccountInput {
  readonly ownerProgram: string;
  readonly executable: false;
  readonly dataBase64: string;
  readonly expectedMint: string;
  readonly expectedOwner: string;
}

// Raw state.rs facts only. The caller must qualify observation provenance,
// account relationships and eligibility separately. Null authority is the
// encoded COption::None, without an inferred effective authority.
export interface ClassicSolanaTokenAccount {
  readonly mint: string;
  readonly owner: string;
  readonly amount: string;
  readonly delegate: string | null;
  readonly delegatedAmount: string;
  readonly state: "uninitialized" | "initialized" | "frozen";
  readonly initialized: boolean;
  readonly frozen: boolean;
  readonly isNative: boolean;
  readonly nativeReserveLamports: string | null;
  readonly closeAuthority: string | null;
  readonly decoderSource: string;
}

function invalid(): never {
  throw new Error("SOLANA_TOKEN_ACCOUNT_INPUT_INVALID");
}
function fields(input: unknown): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== FIELDS.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !FIELDS.includes(key as (typeof FIELDS)[number])
    )
  )
    invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const name of FIELDS) {
    const field = descriptors[name];
    if (
      !field?.enumerable ||
      !Object.prototype.hasOwnProperty.call(field, "value")
    )
      invalid();
    result[name] = field.value;
  }
  return result;
}
function address(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 44 ||
    new PublicKey(value).toBase58() !== value
  )
    invalid();
  return value;
}
function option(bytes: Buffer, offset: number): boolean {
  const tag = bytes.readUInt32LE(offset);
  if (tag !== 0 && tag !== 1) invalid();
  return tag === 1;
}

// This mirrors Account::unpack_from_slice and its exact 165-byte layout.
// Uninitialized and frozen states remain facts, without a permission decision.
export function decodeClassicSolanaTokenAccount(
  input: ClassicSolanaTokenAccountInput
): ClassicSolanaTokenAccount {
  let result: ClassicSolanaTokenAccount;
  let expectedMint: string, expectedOwner: string;
  try {
    const value = fields(input);
    expectedMint = address(value.expectedMint);
    expectedOwner = address(value.expectedOwner);
    if (
      value.ownerProgram !== TOKEN ||
      value.executable !== false ||
      typeof value.dataBase64 !== "string" ||
      value.dataBase64.length !== 220 ||
      !/^[A-Za-z0-9+/]{220}$/.test(value.dataBase64)
    )
      invalid();
    const bytes = Buffer.from(value.dataBase64, "base64");
    if (bytes.length !== 165 || bytes.toString("base64") !== value.dataBase64)
      invalid();
    const state = bytes[108];
    if (state > 2) invalid();
    const native = option(bytes, 109);
    result = Object.freeze({
      mint: new PublicKey(bytes.subarray(0, 32)).toBase58(),
      owner: new PublicKey(bytes.subarray(32, 64)).toBase58(),
      amount: bytes.readBigUInt64LE(64).toString(),
      delegate: option(bytes, 72)
        ? new PublicKey(bytes.subarray(76, 108)).toBase58()
        : null,
      delegatedAmount: bytes.readBigUInt64LE(121).toString(),
      state: (["uninitialized", "initialized", "frozen"] as const)[state],
      initialized: state !== 0,
      frozen: state === 2,
      isNative: native,
      nativeReserveLamports: native
        ? bytes.readBigUInt64LE(113).toString()
        : null,
      closeAuthority: option(bytes, 129)
        ? new PublicKey(bytes.subarray(133, 165)).toBase58()
        : null,
      decoderSource: SOURCE,
    });
  } catch {
    // Do not inspect unknown errors from caller-controlled object traps.
    invalid();
  }
  if (result.mint !== expectedMint)
    throw new Error("SOLANA_TOKEN_ACCOUNT_MINT_MISMATCH");
  if (result.owner !== expectedOwner)
    throw new Error("SOLANA_TOKEN_ACCOUNT_OWNER_MISMATCH");
  return result;
}
