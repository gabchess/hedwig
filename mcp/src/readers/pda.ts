import { createHash } from "node:crypto";

// Solana's Program Derived Address search, reimplemented in pure BigInt:
// no Solana library, no network. A PDA is the first candidate hash, over
// bump 255 down to 0, that is NOT a point on the ed25519 curve.

const PDA_MARKER = Buffer.from("ProgramDerivedAddress", "utf8");
const CURVE25519_P = (1n << 255n) - 19n;

function mod(value: bigint, modulus: bigint): bigint {
  return ((value % modulus) + modulus) % modulus;
}

function modInverse(value: bigint, modulus: bigint): bigint {
  let [oldR, r] = [mod(value, modulus), modulus];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }
  return mod(oldS, modulus);
}

function powMod(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = mod(base, modulus);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) {
      result = mod(result * b, modulus);
    }
    e >>= 1n;
    b = mod(b * b, modulus);
  }
  return result;
}

const CURVE25519_D = mod(
  -121665n * modInverse(121666n, CURVE25519_P),
  CURVE25519_P
);

// Ed25519 point-membership test on a candidate 32-byte encoding: y is
// little-endian with the sign bit cleared, x^2 = (y^2-1)/(d*y^2+1) mod p,
// and the encoding is a curve point iff x^2 is zero or a quadratic residue
// (Euler's criterion: x2^((p-1)/2) mod p === 1). A non-canonical y (>= p)
// is treated as not a point, the same as an unrecognised encoding.
export function isOnCurve(bytes: Buffer): boolean {
  if (bytes.length !== 32) {
    return false;
  }
  let y = 0n;
  for (let i = 31; i >= 0; i--) {
    y = (y << 8n) | BigInt(bytes[i]);
  }
  y &= (1n << 255n) - 1n;
  if (y >= CURVE25519_P) {
    return false;
  }

  const y2 = mod(y * y, CURVE25519_P);
  const u = mod(y2 - 1n, CURVE25519_P);
  const v = mod(CURVE25519_D * y2 + 1n, CURVE25519_P);
  if (v === 0n) {
    return false;
  }
  const x2 = mod(u * modInverse(v, CURVE25519_P), CURVE25519_P);
  if (x2 === 0n) {
    return true;
  }
  return powMod(x2, (CURVE25519_P - 1n) / 2n, CURVE25519_P) === 1n;
}

export interface FoundProgramAddress {
  address: Buffer;
  bump: number;
}

// seeds || [bump] || programId || "ProgramDerivedAddress", sha256'd, is a
// PDA the first time the hash lands off the curve. Every valid Solana
// program id makes this succeed well before bump reaches 0 in practice.
export function findProgramAddress(
  seeds: Buffer[],
  programId: Buffer
): FoundProgramAddress | undefined {
  for (let bump = 255; bump >= 0; bump--) {
    const hash = createHash("sha256")
      .update(
        Buffer.concat([...seeds, Buffer.from([bump]), programId, PDA_MARKER])
      )
      .digest();
    if (!isOnCurve(hash)) {
      return { address: hash, bump };
    }
  }
  return undefined;
}
