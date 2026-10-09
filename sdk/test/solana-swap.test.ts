import { expect } from "chai";
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as sdk from "../src";

// Source-labeled wire fixtures with inert addresses. No live pool, quote,
// instruction eligibility, signing, RPC or transaction execution is implied.
const PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const address = (byte: number) =>
  new PublicKey(Buffer.alloc(32, byte)).toBase58();
// IDL field order, independently encoded with integer.to_bytes little-endian:
// f8c69e91e17587c8, input100000000, min10912473, sqrt0, exactIn=true.
const WIRE_HEX =
  "f8c69e91e17587c800e1f50500000000d982a600000000000000000000000000000000000000000001";
const expectedMetas = () => [
  { address: address(1), isSigner: true, isWritable: false },
  { address: address(2), isSigner: false, isWritable: false },
  { address: address(3), isSigner: false, isWritable: true },
  { address: address(4), isSigner: false, isWritable: true },
  { address: address(5), isSigner: false, isWritable: true },
  { address: address(6), isSigner: false, isWritable: true },
  { address: address(7), isSigner: false, isWritable: true },
  { address: address(8), isSigner: false, isWritable: true },
  { address: TOKEN, isSigner: false, isWritable: false },
  { address: address(9), isSigner: false, isWritable: true },
];
function input(): any {
  return {
    accounts: {
      payer: address(1),
      ammConfig: address(2),
      poolState: address(3),
      inputTokenAccount: address(4),
      outputTokenAccount: address(5),
      inputVault: address(6),
      outputVault: address(7),
      observationState: address(8),
      tickArray: address(9),
    },
    amount: "100000000",
    minimumOutputAmount: "10912473",
    sqrtPriceLimitX64: "0",
    remainingAccounts: [],
  };
}
function view(): any {
  return {
    programId: PROGRAM,
    accounts: expectedMetas(),
    dataBase64: Buffer.from(WIRE_HEX, "hex").toString("base64"),
  };
}
function exported(name: string): (...args: any[]) => any {
  const fn = (sdk as any)[name];
  expect(fn, `public SDK ${name}`).to.be.a("function");
  return fn;
}
function build(value = input()): any {
  return exported("buildRaydiumClassicSwapInstruction")(value);
}
function decode(value = view(), remaining: any[] = []): any {
  return exported("decodeRaydiumClassicSwapInstruction")(value, remaining);
}
function refusesBuild(value: any): void {
  const fn = exported("buildRaydiumClassicSwapInstruction");
  expect(() => fn(value)).to.throw(/^SOLANA_SWAP_/);
}
function refusesDecode(value: any, remaining: any[] = []): void {
  const fn = exported("decodeRaydiumClassicSwapInstruction");
  expect(() => fn(value, remaining)).to.throw(/^SOLANA_SWAP_/);
}

describe("direct classic Raydium unsigned wire mechanics", () => {
  it("builds the independent 41-byte fixture and all ten official fixed metas", () => {
    const ix = build();
    expect(ix.programId.toBase58()).to.equal(PROGRAM);
    expect(ix.data.toString("hex")).to.equal(WIRE_HEX);
    expect(ix.data.length).to.equal(41);
    expect(
      ix.keys.map((k: any) => ({
        address: k.pubkey.toBase58(),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      }))
    ).to.deep.equal(expectedMetas());
  });
  it("decodes independent wire bytes into frozen request-local arguments", () => {
    const result = decode();
    expect(result).to.deep.equal({ ...input(), isBaseInput: true });
    expect(Object.isFrozen(result)).to.equal(true);
    expect(Object.isFrozen(result.accounts)).to.equal(true);
    expect(Object.isFrozen(result.remainingAccounts)).to.equal(true);
    for (const permission of ["eligible", "score", "proceed", "verdict"])
      expect(result).not.to.have.property(permission);
  });
  it("allows the compiled fee payer writable flag without widening other roles", () => {
    const compiled = view();
    compiled.accounts[0].isWritable = true;
    expect(decode(compiled).accounts.payer).to.equal(address(1));
  });
  for (const version of ["legacy", 0] as const)
    it(`decodes the actual shared S1 ${version} capture without inventing local privileges`, () => {
      const ix = build();
      const blockhash = address(20);
      const genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
      const message = new TransactionMessage({
        payerKey: new PublicKey(address(1)),
        recentBlockhash: blockhash,
        instructions: [ix],
      });
      const tx = new VersionedTransaction(
        version === 0
          ? message.compileToV0Message()
          : message.compileToLegacyMessage()
      );
      const capture = sdk.captureSolanaProposal(
        {
          chainId: "solana:mainnet",
          action: "swap",
          transaction: {
            encoding: "base64",
            bytes: Buffer.from(tx.serialize()).toString("base64"),
          },
          solanaIntent: {
            inputKind: "native",
            inputSymbol: "SOL",
            outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            inputAmountLamports: "100000000",
            quotedOutputAmount: "10967309",
            minOutputAmount: "10912473",
            recipient: address(1),
            maxSlippageBps: 50,
            maxFeeLamports: "10000",
          },
        },
        {
          owner: address(1),
          expectedGenesisHash: genesis,
          observedGenesisHash: genesis,
          sourceId: "offline-classic-wire",
          observedAtMs: 100000,
          slot: 10,
          currentBlockHeight: 100,
          lastValidBlockHeight: 120,
          quoteId: "offline-classic-wire",
          blockhash,
          quoteExpiresAtMs: 110000,
          addressTables: [],
        },
        100000
      );
      expect(capture.instructions[0].accounts[0].isWritable).to.equal(true);
      expect(decode(capture.instructions[0])).to.deep.equal({
        ...input(),
        isBaseInput: true,
      });
    });
  it("preserves the full u64/u128 representation without truncation", () => {
    const value = input();
    value.amount = "18446744073709551615";
    value.minimumOutputAmount = "18446744073709551615";
    value.sqrtPriceLimitX64 = "340282366920938463463374607431768211455";
    const ix = build(value);
    expect(ix.data.subarray(8, 40).equals(Buffer.alloc(32, 255))).to.equal(
      true
    );
    const decoded = view();
    decoded.dataBase64 = ix.data.toString("base64");
    expect(decode(decoded)).to.deep.equal({ ...value, isBaseInput: true });
  });
  for (const field of ["amount", "minimumOutputAmount"])
    for (const bad of ["0", "01", "-1", "1.2", "18446744073709551616", 123, 1n])
      it(`rejects invalid ${field} ${String(bad)}`, () => {
        const value = input();
        value[field] = bad;
        refusesBuild(value);
      });
  for (const bad of [
    "00",
    "-1",
    "1.2",
    "340282366920938463463374607431768211456",
    0,
  ])
    it(`rejects invalid u128 ${String(bad)}`, () => {
      const value = input();
      value.sqrtPriceLimitX64 = bad;
      refusesBuild(value);
    });
  it("rejects absent, surplus and non-data builder inputs without invoking getters", () => {
    const missing = input();
    delete missing.accounts.tickArray;
    refusesBuild(missing);
    const extra = input();
    extra.programId = PROGRAM;
    refusesBuild(extra);
    const nested = input();
    nested.accounts.tokenProgram = TOKEN;
    refusesBuild(nested);
    let calls = 0;
    const getter = input();
    Object.defineProperty(getter, "amount", {
      enumerable: true,
      get: () => {
        calls++;
        return "123";
      },
    });
    refusesBuild(getter);
    expect(calls).to.equal(0);
  });
  it("rejects invalid and duplicate account addresses", () => {
    const invalid = input();
    invalid.accounts.poolState = "not-a-key";
    refusesBuild(invalid);
    const duplicate = input();
    duplicate.accounts.outputVault = duplicate.accounts.inputVault;
    refusesBuild(duplicate);
  });
  for (const edit of [
    (v: any) => {
      v.programId = TOKEN;
    },
    (v: any) => {
      v.accounts[8].address = address(10);
    },
    (v: any) => {
      v.accounts[0].isSigner = false;
    },
    (v: any) => {
      v.accounts[1].isSigner = true;
    },
    (v: any) => {
      v.accounts[1].isWritable = true;
    },
    (v: any) => {
      v.accounts[2].isWritable = false;
    },
    (v: any) => {
      v.accounts[8].isWritable = true;
    },
    (v: any) => {
      v.accounts[9].isWritable = false;
    },
    (v: any) => {
      v.accounts[4].address = v.accounts[3].address;
    },
    (v: any) => {
      v.accounts.pop();
    },
  ])
    it("refuses a wrong program, signer, privilege or fixed account inventory", () => {
      const value = view();
      edit(value);
      refusesDecode(value);
    });
  for (const edit of [
    (b: Buffer) => b.subarray(0, 40),
    (b: Buffer) => Buffer.concat([b, Buffer.from([0])]),
    (b: Buffer) => {
      b[0] = 0;
      return b;
    },
    (b: Buffer) => {
      b[40] = 0;
      return b;
    },
    (b: Buffer) => {
      b[40] = 2;
      return b;
    },
    (b: Buffer) => {
      b.fill(0, 8, 16);
      return b;
    },
    (b: Buffer) => {
      b.fill(0, 16, 24);
      return b;
    },
  ])
    it("refuses malformed, trailing, zero-amount or non-exact-in bytes", () => {
      const value = view();
      value.dataBase64 = edit(Buffer.from(WIRE_HEX, "hex")).toString("base64");
      refusesDecode(value);
    });
  it("rejects noncanonical base64 and unknown instruction properties", () => {
    const value = view();
    value.dataBase64 += "\n";
    refusesDecode(value);
    const extra = view();
    extra.sourceConclusion = "safe";
    refusesDecode(extra);
  });
  it("binds explicitly declared writable tick-array suffix metas without granting eligibility", () => {
    const value = input();
    value.remainingAccounts = [{ kind: "tick-array", address: address(10) }];
    const ix = build(value);
    expect(ix.keys).to.have.length(11);
    expect(ix.keys[10].pubkey.toBase58()).to.equal(address(10));
    expect(ix.keys[10].isSigner).to.equal(false);
    expect(ix.keys[10].isWritable).to.equal(true);
    const raw = view();
    raw.accounts.push({
      address: address(10),
      isSigner: false,
      isWritable: true,
    });
    expect(
      decode(raw, value.remainingAccounts).remainingAccounts
    ).to.deep.equal(value.remainingAccounts);
    refusesDecode(raw);
    raw.accounts[10].isWritable = false;
    refusesDecode(raw, value.remainingAccounts);
  });
  it("refuses unsupported bitmap, duplicate, oversized and unbound remaining roles", () => {
    for (const rows of [
      [{ kind: "bitmap-extension", address: address(10) }],
      [{ kind: "tick-array", address: address(9) }],
      [10, 11, 12, 13].map((n) => ({
        kind: "tick-array",
        address: address(n),
      })),
    ]) {
      const value = input();
      value.remainingAccounts = rows;
      refusesBuild(value);
    }
    const raw = view();
    raw.accounts.push({
      address: address(10),
      isSigner: true,
      isWritable: true,
    });
    refusesDecode(raw, [{ kind: "tick-array", address: address(10) }]);
    raw.accounts[10].isSigner = false;
    refusesDecode(raw, [{ kind: "tick-array", address: address(11) }]);
  });
  it("copies caller inputs so later mutation cannot change constructed bytes or decoded arguments", () => {
    const value = input();
    const ix = build(value);
    value.amount = "1";
    value.accounts.inputVault = address(20);
    expect(ix.data.toString("hex")).to.equal(WIRE_HEX);
    expect(ix.keys[5].pubkey.toBase58()).to.equal(address(6));
    const raw = view();
    const decoded = decode(raw);
    raw.accounts[3].address = address(21);
    expect(decoded.accounts.inputTokenAccount).to.equal(address(4));
  });
});
