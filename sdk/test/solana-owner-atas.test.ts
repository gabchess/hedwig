import { expect } from "chai";
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as sdk from "../src";

const OWNER = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const OTHER = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
// Frozen before production with independent Python SHA-256/Edwards decompression
// and base58 arithmetic using pinned lib.rs seeds. web3 separately agreed.
const WSOL_ATA = "9UCSts4xyyetUHozTZsytH1CmcBFLBn5iKAp4xB8k2h1";
const USDC_ATA = "8Ae4vjYTZ5Z8mq2GJMUXpU2LDKMsqDaA7Tg7sZ85Gz9T";
const DERIVATION =
  "https://github.com/solana-labs/solana-program-library/blob/b1c44c171bc95e6ee74af12365cb9cbab68be76c/associated-token-account/program/src/lib.rs";
const DECODER =
  "https://github.com/solana-labs/solana-program-library/blob/b1c44c171bc95e6ee74af12365cb9cbab68be76c/token/program/src/state.rs";
const NOW = 100_000;
const INPUT = "SOLANA_OWNER_ATA_INPUT_INVALID";

function context(): sdk.SolanaBindingContext {
  return {
    owner: OWNER,
    expectedGenesisHash: GENESIS,
    observedGenesisHash: GENESIS,
    sourceId: "offline-owner-ata-fixture",
    observedAtMs: NOW,
    slot: 10,
    currentBlockHeight: 100,
    lastValidBlockHeight: 120,
    quoteId: "unsigned-owner-ata-1",
    blockhash: OTHER,
    quoteExpiresAtMs: NOW + 10_000,
    addressTables: [],
  };
}
function capture(
  version: 0 | "legacy" = "legacy",
  references: { address: string; writable: boolean; signer?: boolean }[] = [
    { address: WSOL_ATA, writable: true },
    { address: USDC_ATA, writable: true },
  ],
  c = context()
): sdk.CapturedSolanaProposal {
  const message = new TransactionMessage({
    payerKey: new PublicKey(OWNER),
    recentBlockhash: OTHER,
    instructions: [
      new TransactionInstruction({
        programId: new PublicKey(TOKEN),
        keys: references.map((r) => ({
          pubkey: new PublicKey(r.address),
          isWritable: r.writable,
          isSigner: r.signer ?? false,
        })),
        data: Buffer.alloc(0),
      }),
    ],
  });
  const tx = new VersionedTransaction(
    version === 0
      ? message.compileToV0Message()
      : message.compileToLegacyMessage()
  );
  return sdk.captureSolanaProposal(
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
        outputMint: USDC,
        inputAmountLamports: "100000000",
        quotedOutputAmount: "100",
        minOutputAmount: "95",
        recipient: OWNER,
        maxSlippageBps: 50,
        maxFeeLamports: "10000",
      },
    },
    c,
    NOW
  );
}
function account(mint: string, native = false): Buffer {
  const bytes = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(bytes, 0);
  new PublicKey(OWNER).toBuffer().copy(bytes, 32);
  bytes.writeBigUInt64LE(100000000n, 64);
  bytes[108] = 1;
  if (native) {
    bytes.writeUInt32LE(1, 109);
    bytes.writeBigUInt64LE(2039280n, 113);
  }
  return bytes;
}
function observations(c = capture()): sdk.SolanaProfileObservations {
  return {
    version: 1,
    requestDigest: c.requestDigest,
    messageDigest: c.messageDigest,
    bindingContext: context(),
    commitment: "confirmed",
    accounts: [
      {
        address: WSOL_ATA,
        status: "found",
        ownerProgram: TOKEN,
        executable: false,
        lamports: "102039280",
        dataBase64: account(WSOL, true).toString("base64"),
        slot: 10,
        observedAtMs: NOW,
      },
      {
        address: USDC_ATA,
        status: "found",
        ownerProgram: TOKEN,
        executable: false,
        lamports: "2039280",
        dataBase64: account(USDC).toString("base64"),
        slot: 10,
        observedAtMs: NOW,
      },
    ],
  };
}
function verify(c: unknown, o: unknown, now = NOW): any {
  const fn = (sdk as unknown as Record<string, unknown>)[
    "verifySolanaOwnerAtas"
  ];
  expect(fn, "public SDK owner ATA relation checker").to.be.a("function");
  return (fn as (c: unknown, o: unknown, n: number) => unknown)(c, o, now);
}
function refuses(c: unknown, o: unknown, code = INPUT, now = NOW): void {
  expect(() => verify(c, o, now)).to.throw(code);
}
function changed(mutator: (o: any) => void): any {
  const o = observations();
  mutator(o);
  return o;
}

describe("source-bound owner WSOL/native-USDC ATA relations", () => {
  for (const version of ["legacy", 0] as const)
    it(`binds the literal ATA pair to the real ${version} capture without granting permission`, () => {
      const c = capture(version);
      const result = verify(c, observations(c));
      expect(result).to.include({
        version: 1,
        requestDigest: c.requestDigest,
        messageDigest: c.messageDigest,
        owner: OWNER,
        sourceId: "offline-owner-ata-fixture",
        expectedGenesisHash: GENESIS,
        commitment: "confirmed",
        derivationSource: DERIVATION,
      });
      expect(result.wsol).to.deep.equal({
        address: WSOL_ATA,
        mint: WSOL,
        owner: OWNER,
        amount: "100000000",
        delegate: null,
        delegatedAmount: "0",
        state: "initialized",
        initialized: true,
        frozen: false,
        isNative: true,
        nativeReserveLamports: "2039280",
        closeAuthority: null,
        decoderSource: DECODER,
        lamports: "102039280",
        slot: 10,
        observedAtMs: NOW,
      });
      expect(result.usdc).to.include({
        address: USDC_ATA,
        mint: USDC,
        owner: OWNER,
      });
      expect(Object.isFrozen(result)).to.equal(true);
      expect(Object.isFrozen(result.wsol)).to.equal(true);
      expect(Object.isFrozen(result.usdc)).to.equal(true);
      for (const absent of [
        "score",
        "verdict",
        "proceed",
        "eligible",
        "dataBase64",
        "proposalBase64",
        "bindingContext",
      ])
        expect(result).not.to.have.property(absent);
      expect(result.wsol).not.to.have.property("dataBase64");
    });
  it("matches by derived address despite reversed observation order", () => {
    const c = capture();
    const o = observations(c);
    const r = verify(c, { ...o, accounts: [...o.accounts].reverse() });
    expect(r.wsol.address).to.equal(WSOL_ATA);
    expect(r.usdc.address).to.equal(USDC_ATA);
  });
  it("refuses forged capture before examining untrusted observations", () => {
    let calls = 0;
    const o = Object.defineProperty({}, "accounts", {
      get: () => {
        calls++;
        return [];
      },
    });
    refuses({ ...capture() }, o, "SOLANA_OWNER_ATA_CAPTURE_INVALID");
    expect(calls).to.equal(0);
  });
  for (const field of ["requestDigest", "messageDigest"])
    it(`refuses a foreign ${field}`, () =>
      refuses(
        capture(),
        changed((o) => {
          o[field] = "a".repeat(64);
        })
      ));
  for (const [field, value] of [
    ["owner", OTHER],
    ["sourceId", "foreign-reader"],
    ["observedGenesisHash", OTHER],
    ["expectedGenesisHash", OTHER],
    ["quoteId", "foreign-quote"],
    ["blockhash", OWNER],
  ])
    it(`refuses changed trusted context ${field}`, () =>
      refuses(
        capture(),
        changed((o) => {
          o.bindingContext[field] = value;
        }),
        "SOLANA_OWNER_ATA_CONTEXT_INVALID"
      ));
  it("refuses a genuine mainnet-labelled capture whose configured genesis is devnet", () => {
    const ctx = {
      ...context(),
      expectedGenesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      observedGenesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    };
    const c = capture("legacy", undefined, ctx);
    refuses(
      c,
      { ...observations(c), bindingContext: ctx },
      "SOLANA_OWNER_ATA_CONTEXT_INVALID"
    );
  });
  for (const now of [NOW + 10_000, -1, NaN])
    it("refuses expiry or invalid current time", () =>
      refuses(
        capture(),
        observations(),
        "SOLANA_OWNER_ATA_CONTEXT_INVALID",
        now
      ));
  it("requires an explicit fresh context rather than using S1's optional cached-context branch", () => {
    const c = capture();
    const o = { ...observations(c), bindingContext: undefined };
    refuses(c, o, "SOLANA_OWNER_ATA_CONTEXT_INVALID");
    refuses(c, o, "SOLANA_OWNER_ATA_CONTEXT_INVALID", NOW + 10_000);
  });
  for (const [field, value] of [
    ["slot", 9],
    ["observedAtMs", NOW - 1],
    ["observedAtMs", NOW + 1],
  ] as const)
    it(`refuses stale or future account ${field}=${value}`, () =>
      refuses(
        capture(),
        changed((o) => {
          o.accounts[0][field] = value;
        })
      ));
  for (const index of [0, 1]) {
    it(`refuses wrong authority in account ${index} bytes`, () => {
      const o = changed((o) => {
        const b = Buffer.from(o.accounts[index].dataBase64, "base64");
        new PublicKey(OTHER).toBuffer().copy(b, 32);
        o.accounts[index].dataBase64 = b.toString("base64");
      });
      refuses(capture(), o, "SOLANA_TOKEN_ACCOUNT_OWNER_MISMATCH");
    });
    it(`refuses wrong mint in account ${index} bytes`, () => {
      const o = changed((o) => {
        const b = Buffer.from(o.accounts[index].dataBase64, "base64");
        new PublicKey(OTHER).toBuffer().copy(b, 0);
        o.accounts[index].dataBase64 = b.toString("base64");
      });
      refuses(capture(), o, "SOLANA_TOKEN_ACCOUNT_MINT_MISMATCH");
    });
  }
  it("refuses correct token bytes read at a non-derived address", () =>
    refuses(
      capture(),
      changed((o) => {
        o.accounts[0].address = OTHER;
      }),
      "SOLANA_OWNER_ATA_ADDRESS_MISMATCH"
    ));
  for (const refs of [
    [{ address: USDC_ATA, writable: true }],
    [
      { address: WSOL_ATA, writable: false },
      { address: USDC_ATA, writable: true },
    ],
    [
      { address: WSOL_ATA, writable: true },
      { address: USDC_ATA, writable: false },
    ],
    [
      { address: WSOL_ATA, writable: true },
      { address: WSOL_ATA, writable: true },
      { address: USDC_ATA, writable: true },
    ],
  ])
    it("refuses absent, readonly or duplicate message references", () => {
      const c = capture("legacy", refs);
      refuses(c, observations(c), "SOLANA_OWNER_ATA_REFERENCE_INVALID");
    });
  it("a token-account signer is rejected by real S1 admission before this relation seam", () => {
    expect(() =>
      capture("legacy", [
        { address: WSOL_ATA, writable: true, signer: true },
        { address: USDC_ATA, writable: true },
      ])
    ).to.throw("SOLANA_SIGNER_UNSUPPORTED");
  });
  for (const change of [
    (o: any) => {
      o.accounts[1] = { ...o.accounts[0] };
    },
    (o: any) => {
      o.accounts.pop();
    },
    (o: any) => {
      o.accounts.push({ ...o.accounts[0], address: OTHER });
    },
    (o: any) => {
      o.accounts[0] = { address: WSOL_ATA, status: "unavailable" };
    },
    (o: any) => {
      o.accounts[0] = {
        address: WSOL_ATA,
        status: "missing",
        slot: 10,
        observedAtMs: NOW,
      };
    },
  ])
    it("refuses duplicate, aliased, absent, surplus or unavailable observations", () =>
      refuses(capture(), changed(change)));
  for (const [field, value] of [
    ["ownerProgram", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"],
    ["ownerProgram", OTHER],
    ["executable", true],
    ["dataBase64", Buffer.alloc(166).toString("base64")],
    ["lamports", "18446744073709551616"],
    ["lamports", "01"],
    ["surplus", true],
  ] as const)
    it(`refuses invalid token observation ${field}`, () =>
      refuses(
        capture(),
        changed((o) => {
          o.accounts[0][field] = value;
        })
      ));
  for (const change of [
    (o: any) => {
      o.commitment = "processed";
    },
    (o: any) => {
      o.version = 2;
    },
    (o: any) => {
      o.surplus = true;
    },
    (o: any) => {
      o.accounts[Symbol("surplus")] = true;
    },
    (o: any) => {
      delete o.accounts[0];
    },
  ])
    it("refuses malformed or open observation envelopes", () =>
      refuses(capture(), changed(change)));
  it("refuses account and context accessors without invoking them", () => {
    let calls = 0;
    const o = changed((o) =>
      Object.defineProperty(o.accounts[0], "dataBase64", {
        enumerable: true,
        get: () => {
          calls++;
          return "";
        },
      })
    );
    refuses(capture(), o);
    const contextTrap = changed((o) =>
      Object.defineProperty(o.bindingContext, "owner", {
        enumerable: true,
        get: () => {
          calls++;
          return OWNER;
        },
      })
    );
    refuses(capture(), contextTrap, "SOLANA_OWNER_ATA_CONTEXT_INVALID");
    expect(calls).to.equal(0);
  });
  it("normalizes hostile proxy exceptions without inspecting their properties", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    refuses(capture(), revoked.proxy);
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw revoked.proxy;
        },
      }
    );
    refuses(capture(), hostile);
  });
  it("retains a frozen result after mutation and revalidates changed facts on a later call", () => {
    const c = capture();
    const o: any = observations(c);
    const result = verify(c, o);
    o.accounts[0].dataBase64 = account(USDC).toString("base64");
    o.accounts[1].address = OTHER;
    o.bindingContext.owner = OTHER;
    expect(result.wsol.mint).to.equal(WSOL);
    expect(result.usdc.address).to.equal(USDC_ATA);
    expect(c.feePayer).to.equal(OWNER);
    refuses(c, o, "SOLANA_OWNER_ATA_CONTEXT_INVALID");
  });
  it("preserves full u64/state/authority facts without inferring rent or transfer permission", () => {
    const o = changed((o) => {
      const b = account(WSOL, true);
      b.fill(255, 64, 72);
      b.writeUInt32LE(1, 72);
      new PublicKey(OTHER).toBuffer().copy(b, 76);
      b[108] = 2;
      b.fill(255, 113, 121);
      b.fill(255, 121, 129);
      b.writeUInt32LE(1, 129);
      new PublicKey(OTHER).toBuffer().copy(b, 133);
      o.accounts[0].dataBase64 = b.toString("base64");
    });
    const result = verify(capture(), o);
    expect(result.wsol).to.include({
      amount: "18446744073709551615",
      delegatedAmount: "18446744073709551615",
      nativeReserveLamports: "18446744073709551615",
      state: "frozen",
      delegate: OTHER,
      closeAuthority: OTHER,
    });
    expect(result.wsol).not.to.have.property("effectiveCloseAuthority");
  });
});
