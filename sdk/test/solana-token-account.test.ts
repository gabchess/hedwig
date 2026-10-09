import { expect } from "chai";
import * as sdk from "../src";

// Independent literal fixture assembled once with Python integer.to_bytes.
// Pinned state.rs offsets: 0/32/64/72/108/109/121/129. These inert keys and
// bytes establish Account wire facts, with no live account or eligibility.
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MINT = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const OWNER = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const DELEGATE = "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8";
const CLOSE = "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq";
const SOURCE =
  "https://github.com/solana-labs/solana-program-library/blob/b1c44c171bc95e6ee74af12365cb9cbab68be76c/token/program/src/state.rs";
const HEX =
  "0101010101010101010101010101010101010101010101010101010101010101020202020202020202020202020202020202020202020202020202020202020200e1f50500000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

function input(bytes = Buffer.from(HEX, "hex")): Record<string, unknown> {
  return {
    ownerProgram: TOKEN,
    executable: false,
    dataBase64: bytes.toString("base64"),
    expectedMint: MINT,
    expectedOwner: OWNER,
  };
}
function decode(value: unknown = input()): Record<string, unknown> {
  const fn = (sdk as unknown as Record<string, unknown>)[
    "decodeClassicSolanaTokenAccount"
  ];
  expect(fn, "public SDK classic Account decoder").to.be.a("function");
  return (fn as (value: unknown) => Record<string, unknown>)(value);
}
function refuses(
  value: unknown,
  code = "SOLANA_TOKEN_ACCOUNT_INPUT_INVALID"
): void {
  expect(() => decode(value)).to.throw(code);
}
function edit(mutator: (bytes: Buffer) => void): Record<string, unknown> {
  const bytes = Buffer.from(HEX, "hex");
  mutator(bytes);
  return input(bytes);
}

describe("source-pinned classic SPL Account facts", () => {
  // Wrong offsets, omitted fields or numeric conversion must break this fixture.
  it("decodes the independent full 165-byte fixture into frozen request-local facts", () => {
    const value = decode();
    expect(value).to.deep.equal({
      mint: MINT,
      owner: OWNER,
      amount: "100000000",
      delegate: null,
      delegatedAmount: "0",
      state: "initialized",
      initialized: true,
      frozen: false,
      isNative: false,
      nativeReserveLamports: null,
      closeAuthority: null,
      decoderSource: SOURCE,
    });
    expect(Object.isFrozen(value)).to.equal(true);
    for (const permission of ["eligible", "score", "proceed", "verdict"])
      expect(value).not.to.have.property(permission);
  });
  for (const [byte, state, initialized, frozen] of [
    [0, "uninitialized", false, false],
    [1, "initialized", true, false],
    [2, "frozen", true, true],
  ] as const)
    it(`preserves ${state} semantics without granting eligibility`, () => {
      const value = decode(
        edit((b) => {
          b[108] = byte;
        })
      );
      expect(value.state).to.equal(state);
      expect(value.initialized).to.equal(initialized);
      expect(value.frozen).to.equal(frozen);
    });
  for (const byte of [3, 255])
    it(`rejects unsupported AccountState ${byte}`, () =>
      refuses(
        edit((b) => {
          b[108] = byte;
        })
      ));

  it("decodes explicit delegate, native reserve and close authority at their independent offsets", () => {
    const value = decode(
      edit((b) => {
        b.writeUInt32LE(1, 72);
        b.fill(3, 76, 108);
        b.writeUInt32LE(1, 109);
        b.writeBigUInt64LE(2039280n, 113);
        b.writeBigUInt64LE(42n, 121);
        b.writeUInt32LE(1, 129);
        b.fill(4, 133, 165);
      })
    );
    expect(value.delegate).to.equal(DELEGATE);
    expect(value.delegatedAmount).to.equal("42");
    expect(value.nativeReserveLamports).to.equal("2039280");
    expect(value.isNative).to.equal(true);
    expect(value.closeAuthority).to.equal(CLOSE);
  });
  it("ignores body bytes for every None COption as the pinned source requires", () => {
    const value = decode(
      edit((b) => {
        b.fill(255, 76, 108);
        b.fill(255, 113, 121);
        b.fill(255, 133, 165);
      })
    );
    expect(value.delegate).to.equal(null);
    expect(value.nativeReserveLamports).to.equal(null);
    expect(value.isNative).to.equal(false);
    expect(value.closeAuthority).to.equal(null);
  });
  for (const offset of [72, 109, 129])
    for (const tag of [2, 256, 0xffffffff])
      it(`rejects malformed COption tag ${tag} at ${offset}`, () =>
        refuses(
          edit((b) => {
            b.writeUInt32LE(tag, offset);
          })
        ));
  it("preserves all u64 quantities above JavaScript safe integers without rounding", () => {
    const value = decode(
      edit((b) => {
        b.fill(255, 64, 72);
        b.writeUInt32LE(1, 109);
        b.fill(255, 113, 121);
        b.fill(255, 121, 129);
      })
    );
    expect(value.amount).to.equal("18446744073709551615");
    expect(value.delegatedAmount).to.equal("18446744073709551615");
    expect(value.nativeReserveLamports).to.equal("18446744073709551615");
  });
  it("preserves zero amounts and an explicit zero native reserve", () => {
    const value = decode(
      edit((b) => {
        b.fill(0, 64, 72);
        b.writeUInt32LE(1, 109);
      })
    );
    expect(value.amount).to.equal("0");
    expect(value.isNative).to.equal(true);
    expect(value.nativeReserveLamports).to.equal("0");
  });
  for (const size of [0, 82, 164, 166, 355])
    it(`rejects size ${size} including mint and extension layouts`, () =>
      refuses(input(Buffer.alloc(size))));
  for (const program of ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", MINT])
    it("refuses foreign account ownership including Token-2022 at classic length", () =>
      refuses({ ...input(), ownerProgram: program }));
  it("refuses executable token account data", () =>
    refuses({ ...input(), executable: true }));
  it("binds the exact expected mint rather than accepting a caller's token label", () =>
    refuses(
      { ...input(), expectedMint: OWNER },
      "SOLANA_TOKEN_ACCOUNT_MINT_MISMATCH"
    ));
  it("binds the token authority separately from the RPC owner program", () =>
    refuses(
      { ...input(), expectedOwner: MINT },
      "SOLANA_TOKEN_ACCOUNT_OWNER_MISMATCH"
    ));
  for (const field of ["expectedMint", "expectedOwner"])
    for (const value of ["not-a-key", "", 9007199254740992])
      it(`rejects malformed or numeric ${field}`, () =>
        refuses({ ...input(), [field]: value }));
  for (const invalid of [
    null,
    [],
    { ...input(), amount: 9007199254740992 },
    { ...input(), dataBase64: 9007199254740992 },
    { ...input(), dataBase64: String(input().dataBase64) + "\n" },
    { ...input(), dataBase64: String(input().dataBase64).slice(0, -1) },
    { ...input(), expectedOwner: undefined },
  ])
    it("refuses incomplete, surplus and malformed inputs", () =>
      refuses(invalid));
  it("rejects own accessors without invoking them", () => {
    let calls = 0;
    const value = input();
    Object.defineProperty(value, "dataBase64", {
      enumerable: true,
      get: () => {
        calls++;
        return input().dataBase64;
      },
    });
    refuses(value);
    expect(calls).to.equal(0);
  });
  it("preserves Some with an all-zero authority key distinctly from None", () => {
    const value = decode(
      edit((b) => {
        b.writeUInt32LE(1, 72);
        b.writeUInt32LE(1, 129);
      })
    );
    expect(value.delegate).to.equal("11111111111111111111111111111111");
    expect(value.closeAuthority).to.equal("11111111111111111111111111111111");
  });
  it("refuses symbol fields and inherited input contracts", () => {
    refuses({ ...input(), [Symbol("surplus")]: true });
    refuses(Object.assign(Object.create({ kind: "inherited" }), input()));
  });
  it("refuses non-enumerable input fields", () => {
    const value = input();
    Object.defineProperty(value, "expectedOwner", {
      value: OWNER,
      enumerable: false,
    });
    refuses(value);
  });
  it("normalizes throwing object traps without inspecting the thrown value", () => {
    let reads = 0;
    const hostile = new Proxy(
      {},
      {
        get: () => {
          reads++;
          throw new Error("must not inspect");
        },
        getPrototypeOf: () => {
          reads++;
          throw new Error("must not inspect");
        },
      }
    );
    const value = new Proxy(input(), {
      ownKeys: () => {
        throw hostile;
      },
    });
    refuses(value);
    expect(reads).to.equal(0);
  });
  it("copies facts so later mutation of caller input cannot alter the decoded result", () => {
    const value = input();
    const result = decode(value);
    value.expectedOwner = MINT;
    value.dataBase64 = "";
    expect(result.owner).to.equal(OWNER);
    expect(result.amount).to.equal("100000000");
  });
});
