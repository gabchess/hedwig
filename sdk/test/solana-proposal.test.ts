import { createHash } from "node:crypto";
import { expect } from "chai";
import {
  AddressLookupTableAccount, AddressLookupTableProgram, Keypair, PublicKey,
  SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import * as sdk from "../src";

// Temporary test keys create synthetic sign artifacts only. Nothing is persisted,
// funded, sent to a wallet, or submitted to a chain.
const owner = Keypair.generate();
const other = Keypair.generate();
const recipient = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58();
const genesis = Keypair.generate().publicKey.toBase58();
const tableKey = Keypair.generate().publicKey;
const NOW = 100_000;
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const activeSlot = "18446744073709551615";
const table = new AddressLookupTableAccount({
  key: tableKey,
  state: { deactivationSlot: BigInt(activeSlot), lastExtendedSlot: 9,
    lastExtendedSlotStartIndex: 0, addresses: [recipient] },
});

function exported(name: string): (...args: any[]) => any {
  const fn = (sdk as unknown as Record<string, unknown>)[name];
  expect(fn, `public SDK export ${name}`).to.be.a("function");
  return fn as (...args: any[]) => any;
}
function transaction(version: "legacy" | 0 = "legacy", changes: {
  payer?: PublicKey; blockhash?: string; amount?: number; nonce?: boolean;
  extraSigner?: boolean;
} = {}): VersionedTransaction {
  const instructions = changes.nonce ? [SystemProgram.nonceAdvance({
    noncePubkey: recipient, authorizedPubkey: owner.publicKey,
  })] : [SystemProgram.transfer({ fromPubkey: changes.payer ?? owner.publicKey,
    toPubkey: recipient, lamports: changes.amount ?? 123 })];
  if (changes.extraSigner) instructions.push(new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [{ pubkey: other.publicKey, isSigner: true, isWritable: false }],
    data: Buffer.from([1]),
  }));
  const msg = new TransactionMessage({ payerKey: changes.payer ?? owner.publicKey,
    recentBlockhash: changes.blockhash ?? blockhash, instructions });
  return new VersionedTransaction(version === "legacy" ? msg.compileToLegacyMessage()
    : msg.compileToV0Message([table]));
}
function proposal(tx = transaction()): any {
  return { chainId: "solana:mainnet", action: "swap",
    transaction: { encoding: "base64", bytes: Buffer.from(tx.serialize()).toString("base64") },
    solanaIntent: { inputKind: "native", inputSymbol: "SOL", outputMint: usdc,
      inputAmountLamports: "123", quotedOutputAmount: "100", minOutputAmount: "95",
      recipient: owner.publicKey.toBase58(), maxSlippageBps: 50, maxFeeLamports: "10000" } };
}
function context(withTable = false): any {
  return { owner: owner.publicKey.toBase58(), expectedGenesisHash: genesis,
    observedGenesisHash: genesis, sourceId: "offline-rpc-fixture", observedAtMs: NOW,
    slot: 10, currentBlockHeight: 100, lastValidBlockHeight: 120,
    quoteId: "offline-build-1", blockhash, quoteExpiresAtMs: NOW + 10_000,
    addressTables: withTable ? [{ address: tableKey.toBase58(),
      owner: AddressLookupTableProgram.programId.toBase58(), observedAtMs: NOW, slot: 10,
      deactivationSlot: activeSlot, lastExtendedSlot: 9, lastExtendedSlotStartIndex: 0,
      addresses: [recipient.toBase58()] }] : [] };
}
function capture(tx = transaction(), ctx = context()): any {
  return exported("captureSolanaProposal")(proposal(tx), ctx, NOW);
}
function signed(tx = transaction(), signer = owner): string {
  tx.sign([signer]);
  return Buffer.from(tx.serialize()).toString("base64");
}
function receipt(captured: any, patch: any = {}): any {
  return { requestDigest: captured.requestDigest, messageDigest: captured.messageDigest,
    verdict: "ALLOW_UNDER_POLICY", proceed: true, score: 0.91,
    expiresAtMs: NOW + 10_000, ...patch };
}
async function guard(options: any = {}): Promise<any> {
  const { tx = transaction(), ctx = context(), ...overrides } = options;
  return exported("runSolanaPreSignGuard")({ proposal: proposal(tx), context: ctx,
    now: () => NOW, assess: async (captured: any) => receipt(captured),
    refreshContext: async () => ctx, sign: async () => signed(tx), ...overrides });
}

describe("public Solana proposal capture", () => {
  it("captures a canonical unsigned legacy message and its independent message hash", () => {
    const tx = transaction();
    const result = capture(tx);
    expect(result.messageDigest).to.equal(createHash("sha256").update(tx.message.serialize()).digest("hex"));
    expect(result.messageBase64).to.equal(Buffer.from(tx.message.serialize()).toString("base64"));
    expect(result.feePayer).to.equal(owner.publicKey.toBase58());
    expect(result.instructions[0].programId).to.equal("11111111111111111111111111111111");
    expect(result.instructions[0].accounts[1].address).to.equal(recipient.toBase58());
    expect(Object.isFrozen(result)).to.equal(true);
    expect(Object.isFrozen(result.request.solanaIntent)).to.equal(true);
  });
  it("captures v0 with the actual selected ALT addresses", () => {
    const result = capture(transaction(0), context(true));
    expect(result.version).to.equal(0);
    expect(result.instructions[0].accounts[1].address).to.equal(recipient.toBase58());
    expect(result.addressTableBindings[0].writable).to.deep.equal([{ index: 0, address: recipient.toBase58() }]);
  });
  it("keeps request and message binding after caller mutation", () => {
    const input = proposal();
    const result = exported("captureSolanaProposal")(input, context(), NOW);
    input.solanaIntent.minOutputAmount = "1";
    input.transaction.bytes = proposal(transaction("legacy", { amount: 999 })).transaction.bytes;
    expect(result.request.solanaIntent.minOutputAmount).to.equal("95");
    expect(result.proposalBase64).not.to.equal(input.transaction.bytes);
    const different = exported("captureSolanaProposal")({ ...result.request,
      solanaIntent: { ...result.request.solanaIntent, minOutputAmount: "1" } }, context(), NOW);
    expect(different.messageDigest).to.equal(result.messageDigest);
    expect(different.requestDigest).not.to.equal(result.requestDigest);
  });
  it("rejects signed and additional-signer proposals", () => {
    expect(() => capture(VersionedTransaction.deserialize(Buffer.from(signed(), "base64")))).to.throw("SOLANA_PROPOSAL_SIGNED");
    expect(() => capture(transaction("legacy", { extraSigner: true }))).to.throw("SOLANA_SIGNER_UNSUPPORTED");
  });
  it("rejects a different owner fee payer and durable nonce", () => {
    expect(() => capture(transaction("legacy", { payer: other.publicKey }))).to.throw("SOLANA_SIGNER_MISMATCH");
    expect(() => capture(transaction("legacy", { nonce: true }))).to.throw("SOLANA_NONCE_UNSUPPORTED");
  });
  it("rejects noncanonical base64 and trailing transaction bytes", () => {
    for (const bytes of [proposal().transaction.bytes + "\n",
      Buffer.concat([Buffer.from(transaction().serialize()), Buffer.from([0])]).toString("base64")]) {
      expect(() => exported("captureSolanaProposal")({ ...proposal(), transaction: { encoding: "base64", bytes } }, context(), NOW)).to.throw("SOLANA_TRANSACTION_INVALID");
    }
  });
  it("rejects unknown transaction versions and impossible instruction indexes", () => {
    const raw = Buffer.from(transaction(0).serialize());
    raw[65] = 0x81;
    expect(() => exported("captureSolanaProposal")(proposalRaw(raw), context(true), NOW)).to.throw("SOLANA_TRANSACTION_INVALID");
    const tx = transaction(0);
    tx.message.compiledInstructions[0].programIdIndex = 255;
    expect(() => capture(tx, context(true))).to.throw("SOLANA_INSTRUCTION_INVALID");
  });
  it("enforces the closed request, decimal amounts, question cap and decoded-size cap", () => {
    const cases = [ { ...proposal(), rpcUrl: "https://caller.invalid" },
      { ...proposal(), question: "x".repeat(2001) },
      { ...proposal(), solanaIntent: { ...proposal().solanaIntent, inputAmountLamports: "01" } },
      { ...proposal(), solanaIntent: { ...proposal().solanaIntent, maxSlippageBps: 10001 } },
      { ...proposal(), transaction: { encoding: "base64", bytes: Buffer.alloc(1233).toString("base64") } } ];
    const captureFn = exported("captureSolanaProposal");
    for (const input of cases) expect(() => captureFn(input, context(), NOW)).to.throw();
  });
  it("stops oversized snapshot traversal before examining later caller data", () => {
    let laterInspected = false;
    const later = new Proxy({}, { getPrototypeOf: () => {
      laterInspected = true; return Object.prototype;
    } });
    const captureFn = exported("captureSolanaProposal");
    expect(() => captureFn({ ...proposal(), tooLarge: Array(2000).fill("x".repeat(1000)), later }, context(), NOW)).to.throw("SOLANA_INPUT_INVALID");
    expect(laterInspected).to.equal(false);
  });
  it("accepts the closed unsigned controlled deposit branch without assigning a verdict", () => {
    const input = { chainId: "solana:mainnet", action: "deposit", transaction: proposal().transaction,
      solanaIntent: { assetMint: usdc, amountBaseUnits: "1", claimedProgram: usdc,
        recipient: owner.publicKey.toBase58() } };
    const result = exported("captureSolanaProposal")(input, context(), NOW);
    expect(result.request.action).to.equal("deposit");
    expect(result).not.to.have.property("score");
    expect(result).not.to.have.property("verdict");
  });
  it("rejects unproved network identity, expired quote, stale facts and expired block height", () => {
    const cases = [ { ...context(), observedGenesisHash: other.publicKey.toBase58() },
      { ...context(), blockhash: other.publicKey.toBase58() },
      { ...context(), quoteExpiresAtMs: NOW }, { ...context(), currentBlockHeight: 121 },
      { ...context(), observedAtMs: NOW - 60_001 }, { ...context(), observedAtMs: NOW + 1 } ];
    const captureFn = exported("captureSolanaProposal");
    for (const ctx of cases) expect(() => captureFn(proposal(), ctx, NOW)).to.throw();
  });
  it("requires complete active correctly owned ALT resolution", () => {
    const ctx = context(true);
    for (const patch of [{ owner: SystemProgram.programId.toBase58() },
      { addresses: [] }, { deactivationSlot: "9" },
      { lastExtendedSlot: 10, lastExtendedSlotStartIndex: 0 }, { slot: 9 }]) {
      expect(() => capture(transaction(0), { ...ctx, addressTables: [{ ...ctx.addressTables[0], ...patch }] })).to.throw("SOLANA_ALT_INVALID");
    }
    expect(() => capture(transaction(0), context())).to.throw("SOLANA_ALT_INVALID");
  });
});
function proposalRaw(bytes: Buffer): any {
  return { ...proposal(), transaction: { encoding: "base64", bytes: bytes.toString("base64") } };
}

describe("public signed Solana artifact verification", () => {
  it("returns the identical message only when the expected signature verifies", () => {
    const captured = capture();
    const result = exported("verifySolanaSignedArtifact")(captured, signed(), context(), NOW);
    expect(result.messageDigest).to.equal(captured.messageDigest);
    expect(result.signature).to.be.a("string").with.length.greaterThan(80);
    expect(Object.isFrozen(result)).to.equal(true);
  });
  it("refuses a changed blockhash, payer or instruction amount", () => {
    for (const tx of [transaction("legacy", { blockhash: other.publicKey.toBase58() }),
      transaction("legacy", { amount: 124 }), transaction("legacy", { payer: other.publicKey })]) {
      const signer = tx.message.staticAccountKeys[0].equals(other.publicKey) ? other : owner;
      expect(() => exported("verifySolanaSignedArtifact")(capture(), signed(tx, signer), context(), NOW)).to.throw("SOLANA_MESSAGE_CHANGED");
    }
  });
  it("refuses an empty or corrupted signature and a forged capture", () => {
    expect(() => exported("verifySolanaSignedArtifact")(capture(), proposal().transaction.bytes, context(), NOW)).to.throw("SOLANA_SIGNATURE_INVALID");
    const raw = Buffer.from(signed(), "base64"); raw[1] ^= 1;
    expect(() => exported("verifySolanaSignedArtifact")(capture(), raw.toString("base64"), context(), NOW)).to.throw("SOLANA_SIGNATURE_INVALID");
    expect(() => exported("verifySolanaSignedArtifact")({ ...capture() }, signed(), context(), NOW)).to.throw("SOLANA_CAPTURE_INVALID");
  });
  it("refuses changed ALT-selected addresses and expired signing artifacts", () => {
    const ctx = context(true); const captured = capture(transaction(0), ctx);
    const artifact = signed(transaction(0));
    expect(() => exported("verifySolanaSignedArtifact")(captured, artifact,
      { ...ctx, addressTables: [{ ...ctx.addressTables[0], addresses: [other.publicKey.toBase58()] }] }, NOW)).to.throw("SOLANA_ALT_CHANGED");
    expect(() => exported("verifySolanaSignedArtifact")(captured, artifact,
      { ...ctx, currentBlockHeight: 121 }, NOW)).to.throw("SOLANA_BLOCKHASH_EXPIRED");
  });
});

describe("public Solana caller pre-sign guard", () => {
  it("assesses the captured request then returns a verified artifact without broadcasting", async () => {
    const order: string[] = [];
    const result = await guard({ assess: async (captured: any) => {
      order.push("assessment"); expect(Object.isFrozen(captured.request)).to.equal(true);
      return receipt(captured);
    }, refreshContext: async () => { order.push("refresh"); return context(); },
    sign: async (captured: any) => { order.push("sign");
      expect(captured.proposalBase64).to.equal(proposal().transaction.bytes); return signed(); } });
    expect(order).to.deep.equal(["assessment", "refresh", "sign", "refresh"]);
    expect(result.status).to.equal("signed");
    expect(result.signerOutcome).to.equal("settled");
    expect(result.artifact.messageDigest).to.equal(capture().messageDigest);
  });
  it("makes zero signing calls for a denied, unknown, malformed or unbound receipt", async () => {
    for (const patch of [{ verdict: "DENY", proceed: false, score: 0 },
      { verdict: "UNKNOWN", proceed: false, score: 0 }, { score: 0.79 },
      { score: NaN }, { requestDigest: "0".repeat(64) }, { messageDigest: "0".repeat(64) },
      { expiresAtMs: NOW }, { unexpected: true }]) {
      let signCalls = 0;
      const result = await guard({ assess: async (captured: any) => receipt(captured, patch),
        sign: async () => { signCalls++; return signed(); } });
      expect(result.status).to.equal("held");
      expect(result.signerOutcome).to.equal("not-attempted");
      expect(signCalls).to.equal(0);
    }
  });
  it("makes zero signing calls when facts expire while assessment or refresh is pending", async () => {
    let now = NOW; let signCalls = 0;
    const result = await guard({ now: () => now,
      assess: async (captured: any) => { now += 10_000; return receipt(captured); },
      sign: async () => { signCalls++; return signed(); } });
    expect(result.status).to.equal("held"); expect(signCalls).to.equal(0);
    now = NOW;
    const refreshed = await guard({ now: () => now, refreshContext: async () => { now += 10_000; return context(); },
      sign: async () => { signCalls++; return signed(); } });
    expect(refreshed.status).to.equal("held"); expect(signCalls).to.equal(0);
  });
  it("holds a changed artifact after signing and never retries the signer", async () => {
    let calls = 0;
    const result = await guard({ sign: async () => { calls++; return signed(transaction("legacy", { amount: 124 })); } });
    expect(result.status).to.equal("held"); expect(result.code).to.equal("SOLANA_MESSAGE_CHANGED");
    expect(result.signerOutcome).to.equal("settled"); expect(calls).to.equal(1);
  });
  it("records an uncertain signer failure without retrying", async () => {
    let calls = 0;
    const result = await guard({ sign: async () => { calls++; throw new Error("private signer detail"); } });
    expect(result.status).to.equal("held"); expect(result.signerOutcome).to.equal("unknown");
    expect(calls).to.equal(1); expect(JSON.stringify(result)).not.to.contain("private signer detail");
  });
  it("settles safely when the signer rejects with a revoked proxy", async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const result = await guard({ dependencyDeadlineMs: 10, sign: async () => { throw proxy; } });
    expect(result.status).to.equal("held");
    expect(result.code).to.equal("SOLANA_DEPENDENCY_FAILED");
    expect(result.signerOutcome).to.equal("unknown");
    expect(result).not.to.have.property("artifact");
  });
  it("checks expiry when the scheduled signing callback starts", async () => {
    let now = NOW, armExpiry = false, signCalls = 0;
    const result = await guard({
      now: () => {
        if (armExpiry) queueMicrotask(() => { now = NOW + 10_000; });
        return now;
      },
      refreshContext: async () => { armExpiry = true; return context(); },
      sign: async () => { signCalls++; return signed(); },
    });
    expect(result.status).to.equal("held");
    expect(result.signerOutcome).to.equal("not-attempted");
    expect(signCalls).to.equal(0);
  });
  it("makes zero signing calls when queued work exhausts the dependency deadline", async () => {
    let armStall = false, queued = false, stalled = false, signCalls = 0;
    const result = await guard({ dependencyDeadlineMs: 20,
      now: () => {
        if (armStall && !queued) {
          queued = true;
          queueMicrotask(() => {
            const until = performance.now() + 60;
            while (performance.now() < until) { /* simulate preceding queued work */ }
            stalled = true;
          });
        }
        return NOW;
      },
      refreshContext: async () => { armStall = true; return context(); },
      sign: async () => { signCalls++; return signed(); },
    });
    expect(stalled).to.equal(true);
    expect(result.code).to.equal("SOLANA_DEPENDENCY_TIMEOUT");
    expect(result.signerOutcome).to.equal("not-attempted");
    expect(signCalls).to.equal(0);
  });
  it("checks the same monotonic deadline after final signing validation", async () => {
    let stallClock = false, stallReads = 0, signCalls = 0;
    const result = await guard({ dependencyDeadlineMs: 20,
      now: () => {
        if (stallClock) {
          const until = performance.now() + 10;
          while (performance.now() < until) { /* slow clock dependency during validation */ }
          stallReads++;
        }
        return NOW;
      },
      refreshContext: async () => { stallClock = true; return context(); },
      sign: async () => { signCalls++; return signed(); },
    });
    expect(stallReads).to.be.at.least(3);
    expect(result.code).to.equal("SOLANA_DEPENDENCY_TIMEOUT");
    expect(result.signerOutcome).to.equal("not-attempted");
    expect(signCalls).to.equal(0);
  });
  it("keeps a timed-out human signing request unknown when its artifact arrives later", async () => {
    let signCalls = 0;
    let finish: ((value: string) => void) | undefined;
    const result = await guard({ dependencyDeadlineMs: 5,
      sign: () => { signCalls++; return new Promise(resolve => { finish = resolve; }); },
    });
    expect(result.status).to.equal("held");
    expect(result.code).to.equal("SOLANA_DEPENDENCY_TIMEOUT");
    expect(result.signerOutcome).to.equal("unknown");
    expect(result).not.to.have.property("artifact");
    finish!(signed());
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(result.status).to.equal("held");
    expect(signCalls).to.equal(1);
  });
  it("makes zero signing calls after an assessment dependency timeout", async () => {
    let signCalls = 0;
    const result = await guard({ dependencyDeadlineMs: 5,
      assess: () => new Promise(() => {}),
      sign: async () => { signCalls++; return signed(); },
    });
    expect(result.status).to.equal("held");
    expect(result.code).to.equal("SOLANA_DEPENDENCY_TIMEOUT");
    expect(result.signerOutcome).to.equal("not-attempted");
    expect(signCalls).to.equal(0);
  });
  it("bounds the human signing wait by the earlier quote expiry", async () => {
    let finish: ((value: string) => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = guard({ ctx: { ...context(), quoteExpiresAtMs: NOW + 10 },
      dependencyDeadlineMs: 100,
      sign: () => new Promise(resolve => { finish = resolve; }),
    });
    const result = await Promise.race([operation,
      new Promise<any>(resolve => { timer = setTimeout(() => resolve({ status: "still-waiting" }), 50); }),
    ]);
    clearTimeout(timer);
    finish?.(signed());
    expect(result.status).to.equal("held");
    expect(result.signerOutcome).to.equal("unknown");
    expect(result).not.to.have.property("artifact");
    await operation;
  });
  it("prevents caller mutation during assessment from changing the signer handoff", async () => {
    const input = proposal();
    const result = await exported("runSolanaPreSignGuard")({ proposal: input, context: context(), now: () => NOW,
      assess: async (captured: any) => { input.solanaIntent.inputAmountLamports = "999";
        input.transaction.bytes = proposal(transaction("legacy", { amount: 999 })).transaction.bytes;
        return receipt(captured); }, refreshContext: async () => context(),
      sign: async (captured: any) => { expect(captured.request.solanaIntent.inputAmountLamports).to.equal("123"); return signed(); } });
    expect(result.status).to.equal("signed");
  });
});
