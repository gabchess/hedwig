import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { CapturedSolanaProposal } from "./solana-proposal";

// Unsigned wire mechanics, not an eligible assessment or account proof.
// Sources: official raydium-clmm Rust swap_instr at ed1eb41519d5355755f7df52b43fa9610938b60b,
// and raydium-idl classic swap at e7e0c96fe77bcf6a020b84a44c47a722aac8e359.
export const RAYDIUM_CLASSIC_PROGRAM_ID =
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const DISCRIMINATOR = Buffer.from("f8c69e91e17587c8", "hex");
const ROLES = [
  "payer",
  "ammConfig",
  "poolState",
  "inputTokenAccount",
  "outputTokenAccount",
  "inputVault",
  "outputVault",
  "observationState",
  "tickArray",
] as const;
const POSITION = [0, 1, 2, 3, 4, 5, 6, 7, 9] as const;
const WRITABLE = new Set([2, 3, 4, 5, 6, 7, 9]);
export interface RaydiumClassicSwapAccounts {
  readonly payer: string;
  readonly ammConfig: string;
  readonly poolState: string;
  readonly inputTokenAccount: string;
  readonly outputTokenAccount: string;
  readonly inputVault: string;
  readonly outputVault: string;
  readonly observationState: string;
  readonly tickArray: string;
}
// A declared wire role supplies no tick-array ownership, data or PDA evidence.
// Bitmap roles remain unsupported until classic privileges are qualified.
export interface RaydiumClassicRemainingAccount {
  readonly kind: "tick-array";
  readonly address: string;
}
export interface RaydiumClassicSwapInput {
  readonly accounts: RaydiumClassicSwapAccounts;
  readonly amount: string;
  readonly minimumOutputAmount: string;
  readonly sqrtPriceLimitX64: string;
  readonly remainingAccounts: readonly RaydiumClassicRemainingAccount[];
}
export interface RaydiumClassicSwapDecoded extends RaydiumClassicSwapInput {
  readonly isBaseInput: true;
}
function invalid(): never {
  throw new Error("invalid wire input");
}
const own = (v: object, k: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(v, k);
function fields(input: unknown, names: readonly string[]): Record<string, any> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== names.length ||
    keys.some((k) => typeof k !== "string" || !names.includes(k))
  )
    invalid();
  const result: Record<string, any> = Object.create(null);
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(input, name);
    if (!field?.enumerable || !own(field, "value")) invalid();
    result[name] = field.value;
  }
  return result;
}
function array(input: unknown, max: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    invalid();
  const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > max ||
    Reflect.ownKeys(input).length !== length + 1
  )
    invalid();
  return Array.from({ length }, (_, i) => {
    const field = Object.getOwnPropertyDescriptor(input, String(i));
    if (!field?.enumerable || !own(field, "value")) invalid();
    return field.value;
  });
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
function uint(value: unknown, bits: 64 | 128, positive = false): bigint {
  if (
    typeof value !== "string" ||
    value.length > (bits === 64 ? 20 : 39) ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  )
    invalid();
  const result = BigInt(value);
  if (result >= 1n << BigInt(bits) || (positive && result === 0n)) invalid();
  return result;
}
function remaining(
  input: unknown,
  fixed: readonly string[]
): RaydiumClassicRemainingAccount[] {
  const seen = new Set(fixed);
  return array(input, 3).map((item) => {
    const row = fields(item, ["kind", "address"]);
    const key = address(row.address);
    if (row.kind !== "tick-array" || seen.has(key)) invalid();
    seen.add(key);
    return { kind: "tick-array", address: key };
  });
}
function fixedAccounts(input: unknown): {
  accounts: RaydiumClassicSwapAccounts;
  addresses: string[];
} {
  const a = fields(input, ROLES);
  const keys = ROLES.map((role) => address(a[role]));
  keys.splice(8, 0, TOKEN);
  if (new Set(keys).size !== keys.length) invalid();
  return {
    accounts: a as unknown as RaydiumClassicSwapAccounts,
    addresses: keys,
  };
}
// Caller prepares a TransactionInstruction only. Capture the complete assembled
// transaction through S1 before assessment. This function has no signer/network.
export function buildRaydiumClassicSwapInstruction(
  input: RaydiumClassicSwapInput
): TransactionInstruction {
  try {
    const v = fields(input, [
      "accounts",
      "amount",
      "minimumOutputAmount",
      "sqrtPriceLimitX64",
      "remainingAccounts",
    ]);
    const amount = uint(v.amount, 64, true),
      minimum = uint(v.minimumOutputAmount, 64, true),
      sqrt = uint(v.sqrtPriceLimitX64, 128);
    const fixed = fixedAccounts(v.accounts);
    const suffix = remaining(v.remainingAccounts, fixed.addresses);
    const data = Buffer.alloc(41);
    DISCRIMINATOR.copy(data);
    data.writeBigUInt64LE(amount, 8);
    data.writeBigUInt64LE(minimum, 16);
    data.writeBigUInt64LE(sqrt & ((1n << 64n) - 1n), 24);
    data.writeBigUInt64LE(sqrt >> 64n, 32);
    data[40] = 1;
    return new TransactionInstruction({
      programId: new PublicKey(RAYDIUM_CLASSIC_PROGRAM_ID),
      data,
      keys: [
        ...fixed.addresses.map((key, i) => ({
          pubkey: new PublicKey(key),
          isSigner: i === 0,
          isWritable: WRITABLE.has(i),
        })),
        ...suffix.map((row) => ({
          pubkey: new PublicKey(row.address),
          isSigner: false,
          isWritable: true,
        })),
      ],
    });
  } catch {
    throw new Error("SOLANA_SWAP_INPUT_INVALID");
  }
}
// Decode the S1 instruction view. Compiled payer writability is expected from
// fee-payer merging; all other admitted privileges remain fixed. A declared
// suffix must bind every remaining address. Its actual type/PDA is checked later.
export function decodeRaydiumClassicSwapInstruction(
  instruction: CapturedSolanaProposal["instructions"][number],
  declaredRemaining: readonly RaydiumClassicRemainingAccount[] = []
): RaydiumClassicSwapDecoded {
  try {
    const v = fields(instruction, ["programId", "accounts", "dataBase64"]);
    if (
      v.programId !== RAYDIUM_CLASSIC_PROGRAM_ID ||
      typeof v.dataBase64 !== "string" ||
      v.dataBase64.length !== 56 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        v.dataBase64
      )
    )
      invalid();
    const data = Buffer.from(v.dataBase64, "base64");
    if (
      data.length !== 41 ||
      data.toString("base64") !== v.dataBase64 ||
      !data.subarray(0, 8).equals(DISCRIMINATOR) ||
      data[40] !== 1
    )
      invalid();
    const rows = array(v.accounts, 13).map((item) =>
      fields(item, ["address", "isSigner", "isWritable"])
    );
    if (rows.length < 10 || rows[8].address !== TOKEN) invalid();
    rows.forEach((row, i) => {
      address(row.address);
      if (
        row.isSigner !== (i === 0) ||
        typeof row.isWritable !== "boolean" ||
        (i !== 0 && row.isWritable !== (i >= 10 || WRITABLE.has(i)))
      )
        invalid();
    });
    if (new Set(rows.map((row) => row.address)).size !== rows.length) invalid();
    const suffix = remaining(
      declaredRemaining,
      rows.slice(0, 10).map((row) => row.address)
    );
    if (
      rows.length !== 10 + suffix.length ||
      suffix.some((row, i) => row.address !== rows[i + 10].address)
    )
      invalid();
    const accounts = Object.fromEntries(
      ROLES.map((role, i) => [role, rows[POSITION[i]].address])
    ) as unknown as RaydiumClassicSwapAccounts;
    const amount = data.readBigUInt64LE(8).toString(),
      minimumOutputAmount = data.readBigUInt64LE(16).toString();
    uint(amount, 64, true);
    uint(minimumOutputAmount, 64, true);
    const sqrtPriceLimitX64 = (
      data.readBigUInt64LE(24) +
      (data.readBigUInt64LE(32) << 64n)
    ).toString();
    return Object.freeze({
      accounts: Object.freeze(accounts),
      amount,
      minimumOutputAmount,
      sqrtPriceLimitX64,
      isBaseInput: true,
      remainingAccounts: Object.freeze(suffix.map((row) => Object.freeze(row))),
    });
  } catch {
    throw new Error("SOLANA_SWAP_WIRE_INVALID");
  }
}
