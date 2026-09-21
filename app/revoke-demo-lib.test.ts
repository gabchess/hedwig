import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import {
  AIRDROP_LAMPORTS,
  MIN_BALANCE_LAMPORTS,
  airdropAmountLamports,
  assertAsk1,
  assertAsk2,
  assertDevnetGenesisHash,
  assertKeypairPathAllowed,
  assertParentSafeForCreate,
  assertServerBuilt,
  assertServerProcessAlive,
  buildConnectionOptions,
  buildMachineRecord,
  buildPolicyFile,
  buildServerEnv,
  createKeypairFile,
  DEFAULT_KEYPAIR_PATH,
  DEVNET_GENESIS_HASH,
  explorerTxUrl,
  extractAskSummary,
  formatTranscript,
  hasTargetDeploySegment,
  isAsk1Valid,
  isAsk2Valid,
  isInsideGitWorkTree,
  isUnderDeniedHomeSubdirectory,
  loadOrGenerateKeypair,
  parseOutPath,
  PERSONAL_NOTES_VAULT_DIR_NAME,
  readExistingKeypair,
  shouldRequestAirdrop,
  type AskSummary,
} from "./revoke-demo-lib";

const FIXTURES = JSON.parse(
  readFileSync(
    join(__dirname, "test", "fixtures", "consult-responses.json"),
    "utf8"
  )
);

// Real answers captured from the built server (see the fixture's own
// "_source" field), never invented verdict strings.
const REAL_ASK1 = extractAskSummary(FIXTURES.allowUnderPolicy) as AskSummary;
const REAL_ASK2 = extractAskSummary(FIXTURES.deny) as AskSummary;

function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// --- genesis hash -----------------------------------------------------

test("assertDevnetGenesisHash accepts devnet's own hash", () => {
  assert.doesNotThrow(() => assertDevnetGenesisHash(DEVNET_GENESIS_HASH));
});

test("assertDevnetGenesisHash refuses any other hash", () => {
  assert.throws(() => assertDevnetGenesisHash("not-devnet"));
});

// Mutant to kill: a `startsWith` check instead of full-string equality.
test("assertDevnetGenesisHash refuses a hash that only shares a prefix", () => {
  assert.throws(() => assertDevnetGenesisHash("EtWTx"));
});

// --- connection options -------------------------------------------------

test("buildConnectionOptions disables the client's own retry-on-rate-limit", () => {
  const options = buildConnectionOptions();
  assert.equal(options.disableRetryOnRateLimit, true);
  assert.equal(options.commitment, "confirmed");
});

// --- server env allowlist -----------------------------------------------

test("buildServerEnv passes through only the allowlist plus the three HEDWIG_* variables", () => {
  const sourceEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/tester",
    ANCHOR_WALLET: "/home/tester/.config/solana/id.json",
    HEDWIG_DEMO_KEYPAIR:
      "/home/tester/.hedwig/demo-keys/revoke-demo-admin.json",
    GITHUB_TOKEN: "gh-secret-token",
    AWS_SECRET_ACCESS_KEY: "aws-secret-value",
  };
  const env = buildServerEnv(
    sourceEnv,
    "/tmp/policy.json",
    "https://api.devnet.solana.com",
    "AdminPubkey111111111111111111111111"
  );
  assert.equal(env.PATH, sourceEnv.PATH);
  assert.equal(env.HOME, sourceEnv.HOME);
  assert.equal(env.HEDWIG_POLICY_FILE, "/tmp/policy.json");
  assert.equal(
    env.HEDWIG_SOLANA_RPC_URL_DEVNET,
    "https://api.devnet.solana.com"
  );
  assert.equal(
    env.HEDWIG_SOLANA_FEE_PAYER_DEVNET,
    "AdminPubkey111111111111111111111111"
  );
  assert.equal("ANCHOR_WALLET" in env, false);
  assert.equal("HEDWIG_DEMO_KEYPAIR" in env, false);
  assert.equal("GITHUB_TOKEN" in env, false);
  assert.equal("AWS_SECRET_ACCESS_KEY" in env, false);
  const serialized = JSON.stringify(env);
  assert.equal(serialized.includes("gh-secret-token"), false);
  assert.equal(serialized.includes("aws-secret-value"), false);
});

// --- server build preflight ----------------------------------------------

test("assertServerBuilt refuses a missing server path before any transaction would be sent", () => {
  const dir = scratchDir("hedwig-revoke-demo-preflight-");
  try {
    assert.throws(() => assertServerBuilt(join(dir, "dist", "server.js")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertServerBuilt accepts a server path that exists", () => {
  const dir = scratchDir("hedwig-revoke-demo-preflight-ok-");
  try {
    const serverPath = join(dir, "server.js");
    writeFileSync(serverPath, "// fake built server\n");
    assert.doesNotThrow(() => assertServerBuilt(serverPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- airdrop decision: capped, and only when needed ----------------------

test("shouldRequestAirdrop is true only under the 0.05 SOL threshold", () => {
  assert.equal(shouldRequestAirdrop(0), true);
  assert.equal(shouldRequestAirdrop(MIN_BALANCE_LAMPORTS - 1), true);
  assert.equal(shouldRequestAirdrop(MIN_BALANCE_LAMPORTS), false);
  assert.equal(shouldRequestAirdrop(MIN_BALANCE_LAMPORTS + 1), false);
});

// Mutant to kill: an airdrop amount that grows with input instead of a
// fixed cap.
test("airdropAmountLamports is a fixed cap, at most 1 SOL, ignoring any input", () => {
  assert.equal(airdropAmountLamports(), AIRDROP_LAMPORTS);
  assert.ok(AIRDROP_LAMPORTS <= 1_000_000_000);
});

// --- keypair path guard: K1 ----------------------------------------------

test("assertKeypairPathAllowed refuses a path inside a git work tree", () => {
  const dir = scratchDir("hedwig-revoke-demo-guard-git-");
  try {
    mkdirSync(join(dir, ".git"));
    const candidate = join(dir, "sub", "revoke-demo-admin.json");
    assert.throws(() => assertKeypairPathAllowed(candidate));
    assert.equal(isInsideGitWorkTree(candidate), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertKeypairPathAllowed accepts a throwaway path outside any git tree", () => {
  const dir = scratchDir("hedwig-revoke-demo-guard-ok-");
  try {
    const candidate = join(dir, "revoke-demo-admin.json");
    assert.doesNotThrow(() => assertKeypairPathAllowed(candidate));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertKeypairPathAllowed refuses a path under a denied home subdirectory (fake home)", () => {
  const fakeHome = scratchDir("hedwig-revoke-demo-fakehome-");
  try {
    mkdirSync(join(fakeHome, ".config", "solana"), { recursive: true });
    mkdirSync(join(fakeHome, "secrets"), { recursive: true });
    mkdirSync(join(fakeHome, PERSONAL_NOTES_VAULT_DIR_NAME), {
      recursive: true,
    });
    // The default wallet name and a sibling name both refuse: the guard is
    // about the directory, not one specific filename.
    assert.throws(() =>
      assertKeypairPathAllowed(
        join(fakeHome, ".config", "solana", "id.json"),
        fakeHome
      )
    );
    assert.throws(() =>
      assertKeypairPathAllowed(
        join(fakeHome, ".config", "solana", "devnet.json"),
        fakeHome
      )
    );
    assert.throws(() =>
      assertKeypairPathAllowed(join(fakeHome, "secrets", "k.json"), fakeHome)
    );
    assert.throws(() =>
      assertKeypairPathAllowed(
        join(fakeHome, PERSONAL_NOTES_VAULT_DIR_NAME, "k.json"),
        fakeHome
      )
    );
    // isUnderDeniedHomeSubdirectory itself receives an already
    // real-resolved checked path in production (realCheckedPath does that
    // resolution); realpath fakeHome here too so the direct call mirrors
    // that, rather than comparing a resolved prefix against an unresolved
    // literal on a machine where the scratch tmp dir sits behind a symlink.
    const realFakeHome = realpathSync(fakeHome);
    assert.equal(
      isUnderDeniedHomeSubdirectory(
        join(realFakeHome, ".config", "solana", "id.json"),
        fakeHome
      ),
      true
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("assertKeypairPathAllowed refuses a target/deploy segment anywhere in the path", () => {
  const dir = scratchDir("hedwig-revoke-demo-guard-deploy-");
  try {
    const candidate = join(dir, "target", "deploy", "p-keypair.json");
    assert.equal(hasTargetDeploySegment(candidate), true);
    assert.throws(() => assertKeypairPathAllowed(candidate));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertKeypairPathAllowed refuses a directory and /dev/stdin", () => {
  const dir = scratchDir("hedwig-revoke-demo-guard-notfile-");
  try {
    const asDirectory = join(dir, "a-directory");
    mkdirSync(asDirectory);
    assert.throws(() => assertKeypairPathAllowed(asDirectory));
    assert.throws(() => assertKeypairPathAllowed("/dev/stdin"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A directory-level symlink trick: the candidate's own final component is
// not a symlink, but an ancestor directory is a symlink into a denied
// location. The lexical string never mentions the denied directory; only
// resolving the real ancestor path catches it.
test("assertKeypairPathAllowed refuses a candidate reached through a symlinked ancestor directory", () => {
  const fakeHome = scratchDir("hedwig-revoke-demo-ancestorlink-home-");
  const outside = scratchDir("hedwig-revoke-demo-ancestorlink-outside-");
  try {
    const realSolanaDir = join(fakeHome, ".config", "solana");
    mkdirSync(realSolanaDir, { recursive: true });
    writeFileSync(join(realSolanaDir, "id.json"), "[0]", { mode: 0o600 });
    const linkDir = join(outside, "looks-harmless");
    symlinkSync(realSolanaDir, linkDir, "dir");
    const candidate = join(linkDir, "id.json");
    assert.throws(() => assertKeypairPathAllowed(candidate, fakeHome));
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// K1: a symlink to a fake wallet is refused, whatever the target holds and
// whether or not it exists.
test("assertKeypairPathAllowed refuses a candidate that is itself a symlink, to an existing file", () => {
  const dir = scratchDir("hedwig-revoke-demo-symlink-existing-");
  try {
    const target = join(dir, "fake-id.json");
    writeFileSync(target, "[0]", { mode: 0o600 });
    const candidate = join(dir, "candidate.json");
    symlinkSync(target, candidate);
    assert.throws(() => assertKeypairPathAllowed(candidate));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertKeypairPathAllowed refuses a dangling symlink whose target is inside a git tree, and nothing is written", () => {
  const gitDir = scratchDir("hedwig-revoke-demo-dangling-git-");
  const outside = scratchDir("hedwig-revoke-demo-dangling-outside-");
  try {
    mkdirSync(join(gitDir, ".git"));
    const danglingTarget = join(gitDir, "newfile.json"); // never created
    const candidate = join(outside, "candidate.json");
    symlinkSync(danglingTarget, candidate);
    assert.throws(() => loadOrGenerateKeypair(candidate));
    assert.equal(statSyncSafe(danglingTarget), undefined);
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function statSyncSafe(p: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

// Guard-order mutant: bait content is a REAL, valid keypair. If the guard
// ran after the read (instead of before), this would parse successfully
// and return a Keypair instead of throwing, and this assertion would fail.
test("loadOrGenerateKeypair refuses a symlink before ever reading its target, even a valid keypair", () => {
  const dir = scratchDir("hedwig-revoke-demo-guard-order-");
  try {
    const bait = Keypair.generate();
    const target = join(dir, "id.json");
    writeFileSync(target, JSON.stringify(Array.from(bait.secretKey)), {
      mode: 0o600,
    });
    const candidate = join(dir, "candidate.json");
    symlinkSync(target, candidate);
    assert.throws(() => loadOrGenerateKeypair(candidate));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOrGenerateKeypair refuses an existing 644 file silently accepted before", () => {
  const dir = scratchDir("hedwig-revoke-demo-mode644-");
  try {
    const target = join(dir, "key.json");
    const kp = Keypair.generate();
    writeFileSync(target, JSON.stringify(Array.from(kp.secretKey)));
    chmodSync(target, 0o644);
    assert.throws(() => loadOrGenerateKeypair(target));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOrGenerateKeypair on junk content throws a fixed message with none of the junk in it", () => {
  const dir = scratchDir("hedwig-revoke-demo-junk-");
  try {
    const target = join(dir, "key.json");
    writeFileSync(target, "JUNKMARKER-not-json-{{{", { mode: 0o600 });
    assert.throws(
      () => loadOrGenerateKeypair(target),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.equal(message.includes("JUNKMARKER"), false);
        assert.equal(message.includes("not-json"), false);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOrGenerateKeypair generates and writes a new file at exactly mode 600", () => {
  const dir = scratchDir("hedwig-revoke-demo-newfile-");
  try {
    const target = join(dir, "sub", "key.json");
    const keypair = loadOrGenerateKeypair(target);
    assert.ok(keypair instanceof Keypair);
    const mode = statSync(target).mode & 0o777;
    assert.equal(mode, 0o600);
    // Round-trips: loading again reads the same key back.
    const again = loadOrGenerateKeypair(target);
    assert.equal(again.publicKey.toBase58(), keypair.publicKey.toBase58());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertParentSafeForCreate leaves an existing 755 parent directory at 755", () => {
  const dir = scratchDir("hedwig-revoke-demo-parent755-");
  try {
    chmodSync(dir, 0o755);
    assert.doesNotThrow(() => assertParentSafeForCreate(dir));
    assert.equal(statSync(dir).mode & 0o777, 0o755);
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertParentSafeForCreate refuses a world-writable existing parent", () => {
  const dir = scratchDir("hedwig-revoke-demo-parent777-");
  try {
    chmodSync(dir, 0o777);
    assert.throws(() => assertParentSafeForCreate(dir));
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Mutant to kill: creating without O_EXCL, silently overwriting whatever
// is already at the path.
test("createKeypairFile refuses to overwrite an existing file (O_EXCL)", () => {
  const dir = scratchDir("hedwig-revoke-demo-excl-");
  try {
    const target = join(dir, "key.json");
    writeFileSync(target, "original-content", { mode: 0o600 });
    assert.throws(() => createKeypairFile(target, new Uint8Array(64)));
    assert.equal(readFileSync(target, "utf8"), "original-content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readExistingKeypair refuses a device path via O_NOFOLLOW/fstat, never echoing content", () => {
  // /dev/null is a real file entry that is not a symlink and not a regular
  // file: exercises the fstat "not a regular file" branch directly.
  assert.throws(() => readExistingKeypair("/dev/null"));
});

test("DEFAULT_KEYPAIR_PATH lives under a dotted hedwig home directory, not the worktree tree", () => {
  assert.ok(DEFAULT_KEYPAIR_PATH.includes(join(".hedwig", "demo-keys")));
  assert.equal(DEFAULT_KEYPAIR_PATH.includes("hedwig-worktrees"), false);
});

// Static source check: the fix removed the only wallet-fallback path this
// file ever had. `ANCHOR_WALLET` never appears in either file.
test("neither revoke-demo.ts nor revoke-demo-lib.ts ever reads ANCHOR_WALLET", () => {
  const libSource = readFileSync(join(__dirname, "revoke-demo-lib.ts"), "utf8");
  const entrySource = readFileSync(join(__dirname, "revoke-demo.ts"), "utf8");
  assert.equal(libSource.includes("ANCHOR_WALLET"), false);
  assert.equal(entrySource.includes("ANCHOR_WALLET"), false);
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

// --- consult answer parsing, built from REAL server responses (H1) -------

test("extractAskSummary reads the real ALLOW_UNDER_POLICY response verbatim", () => {
  assert.equal(REAL_ASK1.proceed, true);
  assert.equal(REAL_ASK1.verdict, "ALLOW_UNDER_POLICY");
  assert.equal(REAL_ASK1.band, "green");
  assert.equal(REAL_ASK1.roleCode, "ROLE_HELD");
});

test("extractAskSummary reads the real DENY response verbatim", () => {
  assert.equal(REAL_ASK2.proceed, false);
  assert.equal(REAL_ASK2.verdict, "DENY");
  assert.equal(REAL_ASK2.support, 0);
  assert.equal(REAL_ASK2.roleCode, "ROLE_MEMBER_MISSING");
});

test("extractAskSummary returns undefined for a message with no structuredContent", () => {
  assert.equal(
    extractAskSummary({ jsonrpc: "2.0", id: 1, result: {} }),
    undefined
  );
  assert.equal(extractAskSummary(null), undefined);
  assert.equal(extractAskSummary("not an object"), undefined);
});

test("extractAskSummary finds the role row by id, not by array position (decoy row first)", () => {
  const decoyFirst = {
    result: {
      structuredContent: {
        proceed: true,
        verdict: "ALLOW_UNDER_POLICY",
        support: 0.92,
        band: "green",
        results: [
          { id: "amount-within-cap", code: "AMOUNT_WITHIN_CAP" },
          { id: "role-requirement-met", code: "ROLE_HELD" },
        ],
      },
    },
  };
  const ask = extractAskSummary(decoyFirst);
  assert.equal(ask?.roleCode, "ROLE_HELD");
  assert.equal(isAsk1Valid(ask), true);
});

// --- ask 1 / ask 2 verdict assertions, real fixtures + killing tests (H2) -

test("ask 1 is valid on the real ALLOW_UNDER_POLICY answer; ask 2 is valid on the real DENY answer", () => {
  assert.equal(isAsk1Valid(REAL_ASK1), true);
  assert.equal(isAsk2Valid(REAL_ASK2), true);
  assert.doesNotThrow(() => assertAsk1(REAL_ASK1));
  assert.doesNotThrow(() => assertAsk2(REAL_ASK2));
});

test("ask 1 is invalid on the real DENY answer, and ask 2 is invalid on the real allow answer", () => {
  assert.equal(isAsk1Valid(REAL_ASK2), false);
  assert.equal(isAsk2Valid(REAL_ASK1), false);
  assert.throws(() => assertAsk1(REAL_ASK2));
  assert.throws(() => assertAsk2(REAL_ASK1));
});

test("ask 2: UNKNOWN with ROLE_MEMBER_MISSING is invalid", () => {
  const ask: AskSummary = { ...REAL_ASK2, verdict: "UNKNOWN" };
  assert.equal(isAsk2Valid(ask), false);
});

test("ask 2: DENY with ROLE_DISABLED is invalid", () => {
  const ask: AskSummary = { ...REAL_ASK2, roleCode: "ROLE_DISABLED" };
  assert.equal(isAsk2Valid(ask), false);
});

test("ask 1: an allow verdict with ROLE_MEMBER_MISSING is invalid", () => {
  const ask: AskSummary = { ...REAL_ASK1, roleCode: "ROLE_MEMBER_MISSING" };
  assert.equal(isAsk1Valid(ask), false);
});

test("ask 2: DENY with proceed:true is invalid", () => {
  const ask: AskSummary = { ...REAL_ASK2, proceed: true };
  assert.equal(isAsk2Valid(ask), false);
});

test("ask 1: proceed:true with ROLE_NOT_REQUIRED is invalid", () => {
  const ask: AskSummary = { ...REAL_ASK1, roleCode: "ROLE_NOT_REQUIRED" };
  assert.equal(isAsk1Valid(ask), false);
});

test("ask 2: proceed:false with ROLE_HELD is invalid", () => {
  const ask: AskSummary = { ...REAL_ASK2, roleCode: "ROLE_HELD" };
  assert.equal(isAsk2Valid(ask), false);
});

// --- one live server process, checked before each ask (H3) ---------------

test("assertServerProcessAlive accepts a live, unsignalled, matching-pid child", () => {
  assert.doesNotThrow(() =>
    assertServerProcessAlive(
      { pid: 100, exitCode: null, signalCode: null },
      100
    )
  );
});

test("assertServerProcessAlive refuses a respawned pid", () => {
  assert.throws(() =>
    assertServerProcessAlive(
      { pid: 999, exitCode: null, signalCode: null },
      100
    )
  );
});

test("assertServerProcessAlive refuses an exited process, even with a matching pid", () => {
  assert.throws(() =>
    assertServerProcessAlive({ pid: 100, exitCode: 1, signalCode: null }, 100)
  );
});

test("assertServerProcessAlive refuses a signalled process, even with a matching pid", () => {
  assert.throws(() =>
    assertServerProcessAlive(
      { pid: 100, exitCode: null, signalCode: "SIGTERM" },
      100
    )
  );
});

// --- transcript formatter: public data only (unchanged behaviour) --------

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
    ask1: REAL_ASK1,
    ask2: REAL_ASK2,
    ask2FirstAttempt: undefined,
  });

  assert.equal(output.includes("rpc.example.com"), true);
  assert.equal(output.includes(rpcUrl), false);
  assert.equal(output.includes("super-secret-path"), false);
  assert.equal(output.includes("SHOULD-NOT-LEAK"), false);
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
  // B5: each printed exactly once.
  const countOf = (needle: string): number => output.split(needle).length - 1;
  assert.equal(countOf("cluster: devnet"), 1);
  assert.equal(countOf(admin.publicKey.toBase58()), 1);
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
    ask1: REAL_ASK1,
    ask2: REAL_ASK2,
    ask2FirstAttempt: undefined,
  });
  assert.equal(output.includes("reused the org"), true);
});

// H4: a kept, honestly described first attempt.
test("formatTranscript describes a retry as a lag only when the first attempt still held the role", () => {
  const admin = Keypair.generate();
  const base = {
    rpcUrl: "https://api.devnet.solana.com",
    admin,
    org: new PublicKey("11111111111111111111111111111111"),
    role: new PublicKey("11111111111111111111111111111111"),
    holder: new PublicKey("11111111111111111111111111111111"),
    createOrgSig: undefined,
    createRoleSig: "roleSig",
    assignRoleSig: "assignSig",
    revokeRoleSig: "revokeSig",
    ask2: REAL_ASK2,
  };

  const lagOutput = formatTranscript({
    ...base,
    ask1: REAL_ASK1,
    ask2FirstAttempt: REAL_ASK1, // still ROLE_HELD: a genuine lag
  });
  assert.equal(lagOutput.includes("RPC lag"), true);

  const failureFirstAttempt: AskSummary = {
    ...REAL_ASK2,
    verdict: "UNKNOWN",
    roleCode: "ROLE_FACT_MISSING",
  };
  const failureOutput = formatTranscript({
    ...base,
    ask1: REAL_ASK1,
    ask2FirstAttempt: failureFirstAttempt,
  });
  assert.equal(failureOutput.includes("RPC lag"), false);
  assert.equal(failureOutput.includes("not a lag"), true);
  assert.equal(failureOutput.includes("ROLE_FACT_MISSING"), true);
});

// --- the machine-readable --out record: public facts only (B4) -----------

test("buildMachineRecord never includes the policy path, env, keypair path or full RPC URL", () => {
  const record = buildMachineRecord({
    rpcUrl: "https://rpc.example.com/CANARY-PATH?api-key=CANARY-KEY",
    serverPid: 111,
    org: "OrgPubkey1111111111111111111111111",
    role: "RolePubkey111111111111111111111111",
    holder: "HolderPubkey11111111111111111111111",
    signatures: {
      createRole: "sig1",
      assignRole: "sig2",
      revokeRole: "sig3",
    },
    ask1: { pid: 111, message: { CANARY: "CANARY-ASK1" } },
    ask2: { pid: 111, message: { CANARY: "CANARY-ASK2" } },
    ask2FirstAttempt: undefined,
  });
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("CANARY-PATH"), false);
  assert.equal(serialized.includes("CANARY-KEY"), false);
  assert.equal(record.rpcHost, "rpc.example.com");
  assert.equal("policyPath" in record, false);
  assert.equal("env" in record, false);
  assert.equal("keypairPath" in record, false);
  // The ask payloads themselves are still recorded (public consult
  // answers), including their canary markers, since only the RPC URL,
  // policy path, keypair path and env are the leak surface this guards.
  assert.equal(serialized.includes("CANARY-ASK1"), true);
});

// --- CLI arg parsing --------------------------------------------------

test("parseOutPath reads the path following --out", () => {
  assert.equal(parseOutPath(["--out", "/tmp/x.json"]), "/tmp/x.json");
  assert.equal(parseOutPath([]), undefined);
  assert.equal(parseOutPath(["--out"]), undefined);
  assert.equal(parseOutPath(["--other", "value"]), undefined);
});
