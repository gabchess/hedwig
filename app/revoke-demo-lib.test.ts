import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import {
  assertAsk1,
  assertAsk2,
  assertDevnetGenesisHash,
  assertKeypairPathAllowed,
  assertSameServerProcess,
  buildPolicyFile,
  DEVNET_GENESIS_HASH,
  explorerTxUrl,
  extractAskSummary,
  formatTranscript,
  isAsk1Valid,
  isAsk2Valid,
  isDefaultSolanaWalletPath,
  isInsideGitWorkTree,
  parseOutPath,
  type AskSummary,
} from "./revoke-demo-lib";

const SAMPLE_ASK1: AskSummary = {
  proceed: true,
  verdict: "PROCEED",
  support: 0.92,
  band: "green",
  roleCode: "ROLE_HELD",
  roleEvidence: "the role is held",
};

const SAMPLE_ASK2: AskSummary = {
  proceed: false,
  verdict: "DENY",
  support: 0,
  band: "red",
  roleCode: "ROLE_MEMBER_MISSING",
  roleEvidence: "the member account is missing",
};

// --- genesis hash -----------------------------------------------------

test("assertDevnetGenesisHash accepts devnet's own hash", () => {
  assert.doesNotThrow(() => assertDevnetGenesisHash(DEVNET_GENESIS_HASH));
});

test("assertDevnetGenesisHash refuses any other hash", () => {
  assert.throws(() => assertDevnetGenesisHash("not-devnet"));
});

// --- keypair path guard -------------------------------------------------

test("assertKeypairPathAllowed refuses a path inside a git work tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "hedwig-revoke-demo-guard-"));
  try {
    mkdirSync(join(dir, ".git"));
    const candidate = join(dir, "sub", "revoke-demo-admin.json");
    assert.throws(() => assertKeypairPathAllowed(candidate));
    assert.equal(isInsideGitWorkTree(candidate), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertKeypairPathAllowed refuses id.json under .config/solana", () => {
  const candidate = join(tmpdir(), ".config", "solana", "id.json");
  assert.equal(isDefaultSolanaWalletPath(candidate), true);
  assert.throws(() => assertKeypairPathAllowed(candidate));
});

test("assertKeypairPathAllowed accepts a throwaway path outside any git tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "hedwig-revoke-demo-guard-ok-"));
  try {
    const candidate = join(dir, "revoke-demo-admin.json");
    assert.doesNotThrow(() => assertKeypairPathAllowed(candidate));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- policy builder -------------------------------------------------------

test("buildPolicyFile produces exactly the expected role block and never a member", () => {
  const policy = buildPolicyFile({
    programId: "H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC",
    role: "RoLePDA111111111111111111111111111",
    holder: "HoLdErPubKey1111111111111111111111",
  });
  assert.deepEqual(policy.role, {
    mode: "required",
    cluster: "devnet",
    programId: "H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC",
    role: "RoLePDA111111111111111111111111111",
    holder: "HoLdErPubKey1111111111111111111111",
    maxAgeSeconds: 60,
  });
  assert.equal("member" in policy.role, false);
  assert.equal(policy.permits, true);
  assert.equal(policy.chainId, "eip155:1");
  assert.deepEqual(policy.perActionCaps, { pay: "1000000" });
});

// --- consult answer parsing and verdict assertions -------------------------

function makeConsultMessage(
  overrides: Partial<{
    proceed: boolean;
    verdict: string;
    support: number;
    band: string;
    roleCode: string;
    roleEvidence: string;
  }>
): unknown {
  const base = {
    proceed: true,
    verdict: "PROCEED",
    support: 0.92,
    band: "green",
    roleCode: "ROLE_HELD",
    roleEvidence: "the role is held",
    ...overrides,
  };
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      structuredContent: {
        proceed: base.proceed,
        verdict: base.verdict,
        support: base.support,
        band: base.band,
        results: [
          {
            id: "role-requirement-met",
            status: "PASS",
            code: base.roleCode,
            evidence: base.roleEvidence,
          },
        ],
      },
    },
  };
}

test("extractAskSummary reads a real-shaped consult answer", () => {
  const ask = extractAskSummary(makeConsultMessage({}));
  assert.deepEqual(ask, SAMPLE_ASK1);
});

test("extractAskSummary returns undefined for a message with no structuredContent", () => {
  assert.equal(
    extractAskSummary({ jsonrpc: "2.0", id: 1, result: {} }),
    undefined
  );
  assert.equal(extractAskSummary(null), undefined);
  assert.equal(extractAskSummary("not an object"), undefined);
});

test("ask 1 must be proceed:true with ROLE_HELD; anything else fails", () => {
  assert.equal(isAsk1Valid(SAMPLE_ASK1), true);
  assert.equal(isAsk1Valid(SAMPLE_ASK2), false);
  assert.doesNotThrow(() => assertAsk1(SAMPLE_ASK1));
  assert.throws(() => assertAsk1(SAMPLE_ASK2));
  assert.throws(() => assertAsk1(undefined));
});

test("ask 2 must be DENY with ROLE_MEMBER_MISSING; UNKNOWN is never accepted", () => {
  assert.doesNotThrow(() => assertAsk2(SAMPLE_ASK2));
  assert.throws(() => assertAsk2(SAMPLE_ASK1));

  // Mutant to kill: the second-ask check accepting UNKNOWN.
  const unknownAsk: AskSummary = {
    proceed: false,
    verdict: "UNKNOWN",
    support: 0,
    band: "red",
    roleCode: undefined,
    roleEvidence: undefined,
  };
  assert.equal(isAsk2Valid(unknownAsk), false);
  assert.throws(() => assertAsk2(unknownAsk));
});

// --- one server process -----------------------------------------------

test("assertSameServerProcess accepts a matching pid and refuses a respawn", () => {
  assert.doesNotThrow(() => assertSameServerProcess(4242, 4242));
  // Mutant to kill: the server being respawned between the two asks.
  assert.throws(() => assertSameServerProcess(4242, 4243));
  assert.throws(() => assertSameServerProcess(undefined, 4242));
});

// --- transcript formatter: public data only --------------------------

test("formatTranscript prints only public keys, signatures and the RPC host", () => {
  const admin = Keypair.generate();
  const org = Keypair.generate().publicKey;
  const role = Keypair.generate().publicKey;
  const holder = Keypair.generate().publicKey;
  const secretBase64 = Buffer.from(admin.secretKey).toString("base64");
  const secretHex = Buffer.from(admin.secretKey).toString("hex");
  const rpcUrl =
    "https://rpc.example.com/super-secret-path?api-key=SHOULD-NOT-LEAK";

  const output = formatTranscript({
    rpcUrl,
    admin,
    org,
    role,
    holder,
    createOrgSig: "orgSig111",
    createRoleSig: "roleSig111",
    assignRoleSig: "assignSig111",
    revokeRoleSig: "revokeSig111",
    ask1: SAMPLE_ASK1,
    ask2: SAMPLE_ASK2,
    ask2RetryUsed: true,
  });

  // Mutant to kill: the transcript printing the full RPC URL.
  assert.equal(output.includes("rpc.example.com"), true);
  assert.equal(output.includes(rpcUrl), false);
  assert.equal(output.includes("super-secret-path"), false);
  assert.equal(output.includes("SHOULD-NOT-LEAK"), false);

  // The secret key, in any encoding this test can cheaply check, never
  // appears; only the public key does.
  assert.equal(output.includes(secretBase64), false);
  assert.equal(output.includes(secretHex), false);
  assert.equal(output.includes(admin.publicKey.toBase58()), true);

  assert.equal(output.includes(org.toBase58()), true);
  assert.equal(output.includes(role.toBase58()), true);
  assert.equal(output.includes(holder.toBase58()), true);
  assert.equal(output.includes(explorerTxUrl("orgSig111")), true);
  assert.equal(
    output.includes(
      "Same server process, same policy file, same request. Only the role changed."
    ),
    true
  );
});

test("formatTranscript notes an org reused from an earlier run when there is no create_org signature", () => {
  const admin = Keypair.generate();
  const output = formatTranscript({
    rpcUrl: "https://api.devnet.solana.com",
    admin,
    org: new PublicKey("11111111111111111111111111111111"),
    role: new PublicKey("11111111111111111111111111111111"),
    holder: new PublicKey("11111111111111111111111111111111"),
    createOrgSig: undefined,
    createRoleSig: "roleSig",
    assignRoleSig: "assignSig",
    revokeRoleSig: "revokeSig",
    ask1: SAMPLE_ASK1,
    ask2: SAMPLE_ASK2,
    ask2RetryUsed: false,
  });
  assert.equal(output.includes("reused the org"), true);
});

// --- CLI arg parsing --------------------------------------------------

test("parseOutPath reads the path following --out", () => {
  assert.equal(parseOutPath(["--out", "/tmp/x.json"]), "/tmp/x.json");
  assert.equal(parseOutPath([]), undefined);
  assert.equal(parseOutPath(["--out"]), undefined);
  assert.equal(parseOutPath(["--other", "value"]), undefined);
});
