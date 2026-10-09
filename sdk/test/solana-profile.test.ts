import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as sdk from "../src";

// Independent unsigned fixtures. No wallet, funding, RPC or submission occurs.
const owner = Keypair.generate().publicKey.toBase58();
const other = Keypair.generate().publicKey.toBase58();
const blockhash = Keypair.generate().publicKey.toBase58();
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SOURCE =
  "https://github.com/solana-labs/solana-program-library/blob/b1c44c171bc95e6ee74af12365cb9cbab68be76c/token/program/src/state.rs";
const NOW = 100_000;
function context(): any {
  return {
    owner,
    expectedGenesisHash: GENESIS,
    observedGenesisHash: GENESIS,
    sourceId: "offline-mainnet-account-fixture",
    observedAtMs: NOW,
    slot: 10,
    currentBlockHeight: 100,
    lastValidBlockHeight: 120,
    quoteId: "unfunded-negative-1",
    blockhash,
    quoteExpiresAtMs: NOW + 10_000,
    addressTables: [],
  };
}
function captured(
  options: {
    program?: string;
    claim?: string;
    recipient?: string;
    asset?: string;
    extra?: boolean;
    swap?: boolean;
    version?: 0 | "legacy";
  } = {}
): any {
  const instruction = new TransactionInstruction({
    programId: new PublicKey(options.program ?? USDC),
    keys: [],
    data: Buffer.alloc(0),
  });
  const instructions = options.extra
    ? [instruction, instruction]
    : [instruction];
  const message = new TransactionMessage({
    payerKey: new PublicKey(owner),
    recentBlockhash: blockhash,
    instructions,
  });
  const tx = new VersionedTransaction(
    options.version === 0
      ? message.compileToV0Message()
      : message.compileToLegacyMessage()
  );
  const intent = options.swap
    ? {
        inputKind: "native",
        inputSymbol: "SOL",
        outputMint: options.asset ?? USDC,
        inputAmountLamports: "123",
        quotedOutputAmount: "100",
        minOutputAmount: "95",
        recipient: options.recipient ?? owner,
        maxSlippageBps: 50,
        maxFeeLamports: "10000",
      }
    : {
        assetMint: options.asset ?? USDC,
        amountBaseUnits: "100",
        claimedProgram: options.claim ?? USDC,
        recipient: options.recipient ?? owner,
      };
  return sdk.captureSolanaProposal(
    {
      chainId: "solana:mainnet",
      action: options.swap ? "swap" : "deposit",
      transaction: {
        encoding: "base64",
        bytes: Buffer.from(tx.serialize()).toString("base64"),
      },
      solanaIntent: intent,
    },
    context(),
    NOW
  );
}
// Official classic Mint: two 36-byte COptions, supply u64 at 36, decimals
// at 44, initialized boolean at 45. None ignores the remaining option bytes.
function mint(): Buffer {
  const data = Buffer.alloc(82);
  data.writeUInt32LE(1, 0);
  Buffer.from(new PublicKey(other).toBytes()).copy(data, 4);
  data.writeBigUInt64LE(123456789n, 36);
  data[44] = 6;
  data[45] = 1;
  data.writeUInt32LE(0, 46);
  data.fill(7, 50);
  return data;
}
function observations(capture: any, data = mint()): any {
  return {
    version: 1,
    requestDigest: capture.requestDigest,
    messageDigest: capture.messageDigest,
    bindingContext: context(),
    commitment: "confirmed",
    accounts: [
      {
        address: USDC,
        status: "found",
        ownerProgram: TOKEN,
        executable: false,
        lamports: "1461600",
        dataBase64: data.toString("base64"),
        observedAtMs: NOW,
        slot: 10,
      },
    ],
  };
}
function policy(profile = "solana-invalid-deposit-v1"): any {
  return {
    version: 1,
    profile,
    chainId: "solana:mainnet",
    expectedGenesisHash: GENESIS,
    sourceId: "offline-mainnet-account-fixture",
    canonicalUsdcMint: USDC,
    classicTokenProgram: TOKEN,
    authorizedFeePayer: owner,
    authorizedRecipient: owner,
  };
}
function evaluate(
  capture: any,
  observation: any,
  configuration: any = policy(),
  time = NOW
): any {
  const fn = (sdk as any).evaluateSolanaProfile;
  expect(fn, "public SDK evaluateSolanaProfile export").to.be.a("function");
  return fn(capture, observation, configuration, time);
}
function unavailable(result: any, code?: string): void {
  expect(result.disposition).to.equal("unavailable");
  expect(result.facts).to.equal(null);
  if (code) expect(result.code).to.equal(code);
  expect(result).not.to.have.property("score");
  expect(result).not.to.have.property("proceed");
}

describe("source-bound Solana controlled invalid-program profile", () => {
  for (const version of ["legacy", 0] as const)
    it(`denies the controlled ${version} fixture from independently decoded mint bytes`, () => {
      const capture = captured({ version });
      const result = evaluate(capture, observations(capture));
      expect(result).to.deep.equal({
        version: 1,
        profile: "solana-invalid-deposit-v1",
        requestDigest: capture.requestDigest,
        messageDigest: capture.messageDigest,
        disposition: "deny",
        code: "INVALID_DEPOSIT_PROGRAM",
        checks: [
          { id: "capture-bound", status: "verified" },
          { id: "network-bound", status: "verified" },
          { id: "program-matches-intent", status: "verified" },
          { id: "mint-is-canonical", status: "verified" },
          { id: "program-is-executable", status: "mismatch" },
        ],
        facts: {
          chainId: "solana:mainnet",
          assetMint: USDC,
          programAddress: USDC,
          ownerProgram: TOKEN,
          executable: false,
          mintInitialized: true,
          mintDecimals: 6,
          decoderSource: SOURCE,
          observedAtMs: NOW,
          slot: 10,
          commitment: "confirmed",
        },
      });
      expect(Object.isFrozen(result)).to.equal(true);
      expect(Object.isFrozen(result.facts)).to.equal(true);
      expect(Object.isFrozen(result.checks[0])).to.equal(true);
      const serialized = JSON.stringify(result);
      for (const privateValue of [
        capture.proposalBase64,
        owner,
        "offline-mainnet-account-fixture",
      ])
        expect(serialized).not.to.contain(privateValue);
    });
  it("accepts both official valid COption encodings without requiring ignored None bodies to be zero", () => {
    const capture = captured();
    const data = mint();
    data.writeUInt32LE(0, 0);
    data.fill(9, 4, 36);
    data.writeUInt32LE(1, 46);
    expect(evaluate(capture, observations(capture, data)).disposition).to.equal(
      "deny"
    );
  });
  for (const length of [0, 81, 83, 165])
    it(`holds the unsupported ${length}-byte mint layout`, () => {
      const capture = captured();
      unavailable(
        evaluate(capture, observations(capture, Buffer.alloc(length))),
        "MINT_DATA_UNAVAILABLE"
      );
    });
  for (const [name, mutate] of [
    ["mint authority option", (b: Buffer) => b.writeUInt32LE(2, 0)],
    ["freeze authority option", (b: Buffer) => b.writeUInt32LE(2, 46)],
    [
      "boolean encoding",
      (b: Buffer) => {
        b[45] = 2;
      },
    ],
    [
      "uninitialized mint",
      (b: Buffer) => {
        b[45] = 0;
      },
    ],
    [
      "non-USDC decimals",
      (b: Buffer) => {
        b[44] = 9;
      },
    ],
  ] as const)
    it(`holds ${name} instead of inferring mint identity`, () => {
      const capture = captured();
      const data = mint();
      mutate(data);
      unavailable(
        evaluate(capture, observations(capture, data)),
        "MINT_DATA_UNAVAILABLE"
      );
    });
  it("requires canonical base64 account bytes and rejects caller-provided parsed claims", () => {
    const capture = captured();
    const obs = observations(capture);
    obs.accounts[0].dataBase64 += "\n";
    unavailable(evaluate(capture, obs), "MINT_DATA_UNAVAILABLE");
    const parsed = observations(capture);
    delete parsed.accounts[0].dataBase64;
    parsed.accounts[0].parsed = { decimals: 6, isInitialized: true };
    unavailable(evaluate(capture, parsed), "OBSERVATIONS_INVALID");
  });
  for (const status of ["missing", "unavailable"])
    it(`holds an explicitly ${status} program observation`, () => {
      const capture = captured();
      const obs = observations(capture);
      obs.accounts =
        status === "missing"
          ? [{ address: USDC, status, slot: 10, observedAtMs: NOW }]
          : [{ address: USDC, status }];
      unavailable(evaluate(capture, obs), "OBSERVATIONS_UNAVAILABLE");
    });
  it("holds missing observations and preserves only trusted capture digests", () => {
    const capture = captured();
    const result = evaluate(capture, null);
    unavailable(result, "OBSERVATIONS_UNAVAILABLE");
    expect(result.requestDigest).to.equal(capture.requestDigest);
  });
  it("rejects copied and caller-forged captures without accepting their claimed digests", () => {
    const capture = captured();
    const result = evaluate({ ...capture }, observations(capture));
    unavailable(result, "CAPTURE_INVALID");
    expect(result.requestDigest).to.equal(null);
    expect(result.messageDigest).to.equal(null);
    expect(result.profile).to.equal(null);
  });
  for (const field of ["requestDigest", "messageDigest"])
    it(`requires the ${field} binding`, () => {
      const capture = captured();
      const obs = observations(capture);
      obs[field] = "0".repeat(64);
      unavailable(evaluate(capture, obs), "OBSERVATIONS_INVALID");
    });
  for (const change of [
    (o: any) => {
      o.bindingContext.observedGenesisHash = other;
    },
    (o: any) => {
      o.bindingContext.expectedGenesisHash = other;
      o.bindingContext.observedGenesisHash = other;
    },
    (o: any) => {
      o.bindingContext.sourceId = "foreign-source";
    },
    (o: any) => {
      o.commitment = "processed";
    },
    (o: any) => {
      o.accounts[0].slot = 9;
    },
    (o: any) => {
      o.accounts[0].observedAtMs = NOW - 60_001;
    },
    (o: any) => {
      o.accounts[0].observedAtMs = NOW + 1;
    },
  ])
    it("holds a foreign, stale or below-context account read", () => {
      const capture = captured();
      const obs = observations(capture);
      change(obs);
      unavailable(evaluate(capture, obs));
    });
  it("rechecks original quote, blockhash height and refreshed context before denial", () => {
    const capture = captured();
    unavailable(
      evaluate(capture, observations(capture), policy(), NOW + 10_000)
    );
    const expired = observations(capture);
    expired.bindingContext.currentBlockHeight = 121;
    unavailable(evaluate(capture, expired));
    const changed = observations(capture);
    changed.bindingContext.quoteId = "different-build";
    unavailable(evaluate(capture, changed));
  });
  for (const field of [
    "expectedGenesisHash",
    "canonicalUsdcMint",
    "classicTokenProgram",
    "authorizedFeePayer",
    "sourceId",
    "chainId",
  ])
    it(`does not let trusted policy silently widen the ${field} pin`, () => {
      const capture = captured();
      const config = policy();
      config[field] =
        field === "sourceId"
          ? "foreign-source"
          : field === "chainId"
          ? "solana:devnet"
          : other;
      unavailable(
        evaluate(capture, observations(capture), config),
        "POLICY_INVALID"
      );
    });
  it("requires the exact observed compiled program and intent relation", () => {
    const capture = captured({ claim: other });
    unavailable(evaluate(capture, observations(capture)), "PROGRAM_UNBOUND");
    const foreign = captured({ program: other, claim: other });
    unavailable(evaluate(foreign, observations(foreign)), "PROGRAM_UNBOUND");
    const surplus = captured({ extra: true });
    unavailable(evaluate(surplus, observations(surplus)), "PROGRAM_UNBOUND");
  });
  for (const change of [
    (o: any) => {
      o.accounts[0].address = other;
    },
    (o: any) => {
      o.accounts.push({ ...o.accounts[0] });
    },
    (o: any) => {
      o.accounts.push({ ...o.accounts[0], address: other });
    },
    (o: any) => {
      o.accounts[0].ownerProgram = other;
    },
    (o: any) => {
      o.accounts[0].executable = true;
    },
  ])
    it("holds unbound, duplicate, surplus or contradictory program facts", () => {
      const capture = captured();
      const obs = observations(capture);
      change(obs);
      unavailable(evaluate(capture, obs));
    });
  it("does not claim an output or recipient mismatch from request labels alone", () => {
    for (const options of [{ asset: other }, { recipient: other }]) {
      const capture = captured(options);
      unavailable(evaluate(capture, observations(capture)), "PROGRAM_UNBOUND");
    }
  });
  it("keeps the unqualified positive swap branch closed even with coherent labels", () => {
    const capture = captured({ swap: true });
    unavailable(
      evaluate(
        capture,
        observations(capture),
        policy("solana-native-usdc-swap-v1")
      ),
      "POSITIVE_ROUTE_UNQUALIFIED"
    );
  });
  it("freezes an immutable result independently of later caller mutations", () => {
    const capture = captured();
    const obs = observations(capture);
    const config = policy();
    const result = evaluate(capture, obs, config);
    obs.accounts[0].executable = true;
    config.canonicalUsdcMint = other;
    expect(result.facts.executable).to.equal(false);
    expect(result.facts.assetMint).to.equal(USDC);
  });
  it("rejects accessors without calling them and stops at the observation byte bound", () => {
    const capture = captured();
    const obs = observations(capture);
    let called = 0;
    Object.defineProperty(obs.accounts[0], "dataBase64", {
      enumerable: true,
      get: () => {
        called++;
        return mint().toString("base64");
      },
    });
    unavailable(evaluate(capture, obs), "OBSERVATIONS_INVALID");
    expect(called).to.equal(0);
    const tooLarge = observations(capture);
    tooLarge.accounts[0].dataBase64 = "A".repeat(256 * 1024);
    unavailable(evaluate(capture, tooLarge), "OBSERVATIONS_INVALID");
  });
});
