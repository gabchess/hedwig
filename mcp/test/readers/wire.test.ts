import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import {
  buildCheckRoleTransaction,
  decodeBase58PublicKey,
  encodeBase58PublicKey,
  encodeCompactU16,
} from "../../src/readers/wire";

const GOLDEN = JSON.parse(
  readFileSync(
    join(__dirname, "..", "fixtures", "solana-role", "check-role-golden.json"),
    "utf8"
  )
);

describe("readers/wire: decodeBase58PublicKey", () => {
  it("decodes 32 zero bytes from 32 leading-zero characters", () => {
    const decoded = decodeBase58PublicKey("1".repeat(32));
    expect(decoded).to.deep.equal(Buffer.alloc(32));
  });

  it("decodes a mix of leading zeros and value bytes to exactly 32 bytes", () => {
    const decoded = decodeBase58PublicKey(GOLDEN.programId);
    expect(decoded).to.be.instanceOf(Buffer);
    expect(decoded).to.have.length(32);
  });

  it("rejects a character outside the strict base58 alphabet", () => {
    // "0", "O", "I", and "l" are never in a base58 string.
    expect(decodeBase58PublicKey("0" + "1".repeat(31))).to.equal(undefined);
    expect(decodeBase58PublicKey("O" + "1".repeat(31))).to.equal(undefined);
    expect(decodeBase58PublicKey("I" + "1".repeat(31))).to.equal(undefined);
    expect(decodeBase58PublicKey("l" + "1".repeat(31))).to.equal(undefined);
  });

  it("rejects the empty string", () => {
    expect(decodeBase58PublicKey("")).to.equal(undefined);
  });

  it("rejects a decoded length of 31 bytes", () => {
    // 31 leading-zero characters decode to 31 zero bytes, one short.
    expect(decodeBase58PublicKey("1".repeat(31))).to.equal(undefined);
  });

  it("rejects a decoded length of 33 bytes", () => {
    expect(decodeBase58PublicKey("1".repeat(33))).to.equal(undefined);
  });

  it("rejects a string over 44 characters before doing the BigInt work", () => {
    // A 32-byte value never needs more than 44 base58 characters; a much
    // longer string must be rejected fast, not walked digit by digit.
    const hostile = "z".repeat(60_000);
    const startedAt = Date.now();
    const result = decodeBase58PublicKey(hostile);
    const elapsedMs = Date.now() - startedAt;

    expect(result).to.equal(undefined);
    expect(elapsedMs).to.be.lessThan(20);
  });

  it("round-trips through encodeBase58PublicKey", () => {
    const original = decodeBase58PublicKey(GOLDEN.programId) as Buffer;
    expect(
      decodeBase58PublicKey(encodeBase58PublicKey(original))
    ).to.deep.equal(original);
  });

  it("encodes 32 zero bytes as 32 leading-zero characters", () => {
    expect(encodeBase58PublicKey(Buffer.alloc(32))).to.equal("1".repeat(32));
  });
});

describe("readers/wire: encodeCompactU16", () => {
  it("encodes 127 as a single byte", () => {
    expect(encodeCompactU16(127)).to.deep.equal(Buffer.from([0x7f]));
  });

  it("encodes 128 as two bytes", () => {
    expect(encodeCompactU16(128)).to.deep.equal(Buffer.from([0x80, 0x01]));
  });

  it("encodes 16383 as two bytes", () => {
    expect(encodeCompactU16(16383)).to.deep.equal(Buffer.from([0xff, 0x7f]));
  });

  it("encodes 16384 as three bytes", () => {
    expect(encodeCompactU16(16384)).to.deep.equal(
      Buffer.from([0x80, 0x80, 0x01])
    );
  });
});

describe("readers/wire: buildCheckRoleTransaction", () => {
  it("matches the golden vector generated from @solana/web3.js, byte for byte", () => {
    const transaction = buildCheckRoleTransaction({
      feePayer: GOLDEN.feePayer,
      member: GOLDEN.member,
      role: GOLDEN.role,
      holder: GOLDEN.holder,
      programId: GOLDEN.programId,
    });

    expect(transaction?.toString("base64")).to.equal(GOLDEN.base64);
  });

  it("returns undefined, never throws, for a malformed address", () => {
    const result = buildCheckRoleTransaction({
      feePayer: GOLDEN.feePayer,
      member: "not-base58!",
      role: GOLDEN.role,
      holder: GOLDEN.holder,
      programId: GOLDEN.programId,
    });

    expect(result).to.equal(undefined);
  });
});
