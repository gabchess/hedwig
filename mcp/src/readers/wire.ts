import { createHash } from "node:crypto";

// Pure wire-format helpers for one on-chain call: a legacy Solana
// transaction carrying a single check_role instruction. No Solana library,
// no network, no clock. Every function here either returns a value or
// returns undefined; none of them throw on bad input.

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map<string, number>(
  Array.from(BASE58_ALPHABET).map((char, index) => [char, index])
);
const PUBLIC_KEY_BYTES = 32;

// Decodes a base58 string into a Buffer, requiring exactly 32 bytes: a
// Solana public key's fixed length. A character outside the strict
// alphabet, an empty string, or a decoded length other than 32 bytes
// returns undefined; every caller in this reader treats an invalid key as
// "no fact", never a crash.
export function decodeBase58PublicKey(value: string): Buffer | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") {
    leadingZeros++;
  }

  let decoded = 0n;
  for (const char of value) {
    const digit = BASE58_INDEX.get(char);
    if (digit === undefined) {
      return undefined;
    }
    decoded = decoded * 58n + BigInt(digit);
  }

  let hex = decoded.toString(16);
  if (hex.length % 2 === 1) {
    hex = `0${hex}`;
  }
  const magnitude = decoded === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  const result = Buffer.concat([Buffer.alloc(leadingZeros), magnitude]);

  return result.length === PUBLIC_KEY_BYTES ? result : undefined;
}

// Solana's "compact-u16" (shortvec) length prefix: 7 data bits per byte,
// the continuation bit set on every byte but the last. Every count in a
// legacy transaction (signatures, account keys, instructions, an
// instruction's own accounts, its data) is framed this way.
export function encodeCompactU16(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  for (;;) {
    const elem = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining === 0) {
      bytes.push(elem);
      break;
    }
    bytes.push(elem | 0x80);
  }
  return Buffer.from(bytes);
}

// Anchor's global instruction discriminator: the first 8 bytes of
// sha256("global:<instruction name>"). check_role takes no arguments, so
// this is the instruction's entire data payload.
export const CHECK_ROLE_DISCRIMINATOR = createHash("sha256")
  .update("global:check_role")
  .digest()
  .subarray(0, 8);

export interface CheckRoleAddresses {
  feePayer: string;
  member: string;
  role: string;
  holder: string;
  programId: string;
}

// A Solana legacy message groups accounts into four tiers (signer+writable,
// signer+readonly, writable, readonly) and, within a tier, orders them by
// their base58 string under this exact collation. member, role, holder,
// and programId all land in the same tier here (none are signers or
// writable), so this is the only thing that decides their order.
// @solana/web3.js's Transaction.compileMessage applies the identical
// comparator; the dev-only golden script in mcp/test/tools proves it.
const ACCOUNT_SORT_OPTIONS: Intl.CollatorOptions = {
  localeMatcher: "best fit",
  usage: "sort",
  sensitivity: "variant",
  ignorePunctuation: false,
  numeric: false,
  caseFirst: "lower",
};

type OtherAccountRole = "member" | "role" | "holder" | "programId";

// Hand-builds the wire bytes of a legacy Solana transaction carrying one
// check_role instruction: one zeroed 64-byte signature slot (sigVerify is
// off on the simulate call that sends this) and a zeroed recent blockhash
// (simulateTransaction's replaceRecentBlockhash fills in a real one). The
// instruction's own account list is fixed by check_role.rs's Accounts
// struct field order (member, role, holder); the shared account-keys array
// they and the program id are written into is ordered as described above.
// Returns undefined, never throws, if any address fails to decode.
export function buildCheckRoleTransaction(
  addresses: CheckRoleAddresses
): Buffer | undefined {
  const feePayer = decodeBase58PublicKey(addresses.feePayer);
  const member = decodeBase58PublicKey(addresses.member);
  const role = decodeBase58PublicKey(addresses.role);
  const holder = decodeBase58PublicKey(addresses.holder);
  const programId = decodeBase58PublicKey(addresses.programId);
  if (!feePayer || !member || !role || !holder || !programId) {
    return undefined;
  }

  const others: Array<{
    role: OtherAccountRole;
    base58: string;
    bytes: Buffer;
  }> = [
    { role: "member", base58: addresses.member, bytes: member },
    { role: "role", base58: addresses.role, bytes: role },
    { role: "holder", base58: addresses.holder, bytes: holder },
    { role: "programId", base58: addresses.programId, bytes: programId },
  ];
  others.sort((a, b) =>
    a.base58.localeCompare(b.base58, "en", ACCOUNT_SORT_OPTIONS)
  );

  const accountKeys = [feePayer, ...others.map((entry) => entry.bytes)];
  const indexOf = (target: OtherAccountRole): number =>
    others.findIndex((entry) => entry.role === target) + 1; // +1: feePayer sits at index 0

  const signatures = Buffer.concat([encodeCompactU16(1), Buffer.alloc(64)]);

  // numRequiredSignatures=1 (feePayer), numReadonlySignedAccounts=0,
  // numReadonlyUnsignedAccounts=4 (member, role, holder, programId).
  const header = Buffer.from([1, 0, 4]);
  const accountKeysSection = Buffer.concat([
    encodeCompactU16(accountKeys.length),
    ...accountKeys,
  ]);
  const recentBlockhash = Buffer.alloc(32);

  const instruction = Buffer.concat([
    Buffer.from([indexOf("programId")]),
    encodeCompactU16(3),
    Buffer.from([indexOf("member"), indexOf("role"), indexOf("holder")]),
    encodeCompactU16(CHECK_ROLE_DISCRIMINATOR.length),
    CHECK_ROLE_DISCRIMINATOR,
  ]);
  const instructions = Buffer.concat([encodeCompactU16(1), instruction]);

  const message = Buffer.concat([
    header,
    accountKeysSection,
    recentBlockhash,
    instructions,
  ]);

  return Buffer.concat([signatures, message]);
}
