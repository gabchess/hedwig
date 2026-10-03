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
import { join, sep } from "node:path";
import { test } from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import {
  AIRDROP_LAMPORTS,
  FEE_LAMPORTS_PER_SIGNATURE,
  LIFECYCLE_ACCOUNT_BYTES,
  MIN_BALANCE_LAMPORTS,
  airdropAmountLamports,
  assertAsk1,
  assertAsk4,
  assertDevnetGenesisHash,
  assertKeypairPathAllowed,
  assertMissingFactAsk,
  assertOverCapAsk,
  assertParentSafeForCreate,
  assertPayerCanCover,
  assertServerBuilt,
  assertServerProcessAlive,
  buildConnectionOptions,
  buildMachineRecord,
  buildPolicyFile,
  buildPolicyFileWithUnrecognizedRoleProgram,
  buildServerEnv,
  createKeypairFile,
  CONSUMER_DEMO_KEYPAIR_PATH,
  DEFAULT_KEYPAIR_PATH,
  DEVNET_GENESIS_HASH,
  explorerTxUrl,
  extractAskSummary,
  formatTranscript,
  hasTargetDeploySegment,
  isAsk1Valid,
  isAsk4Valid,
  isInsideGitWorkTree,
  isMissingFactAskValid,
  isOverCapAskValid,
  isUnderDeniedHomeSubdirectory,
  LIFECYCLE_DEMO_KEYPAIR_PATH,
  loadOrGenerateKeypair,
  parseOutPath,
  requiredPayerLamports,
  PAY_REQUEST,
  PAY_REQUEST_OVER_CAP,
  PERSONAL_NOTES_VAULT_DIR_NAME,
  readExistingKeypair,
  resolveKeypairPath,
  shouldRequestAirdrop,
  UNRECOGNIZED_ROLE_PROGRAM_ID,
  withSwappedPolicyFile,
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
const REAL_ASK4 = extractAskSummary(FIXTURES.deny) as AskSummary;
const REAL_OVER_CAP_ASK = extractAskSummary(FIXTURES.overCapDeny) as AskSummary;
const REAL_MISSING_FACT_ASK = extractAskSummary(
  FIXTURES.missingFactUnknown
) as AskSummary;

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

// --- pre-flight balance floor ---------------------------------------------

// Local-validator measurements (fee 5,000, rent-exempt minimum for a
// zero-data account 890,880): a payer sending 20,000,000 fails below
// 20,895,880 and succeeds at it.
const RENT_EXEMPT_ZERO_DATA = 890_880;

test("requiredPayerLamports adds spend, per-signature fees and the rent-exempt minimum", () => {
  assert.equal(FEE_LAMPORTS_PER_SIGNATURE, 5_000);
  assert.equal(
    requiredPayerLamports({
      spendLamports: 20_000_000,
      signatures: 1,
      rentExemptMinimumLamports: RENT_EXEMPT_ZERO_DATA,
    }),
    20_895_880
  );
  assert.equal(
    requiredPayerLamports({
      spendLamports: 100,
      signatures: 6,
      rentExemptMinimumLamports: 7,
    }),
    100 + 6 * FEE_LAMPORTS_PER_SIGNATURE + 7
  );
});

// Mutants to kill: `<` against the spend alone, and a fee-only floor. Both
// let a balance between the spend and the rent floor through.
test("assertPayerCanCover refuses every balance below the floor and accepts the floor", () => {
  const required = 20_895_880;
  for (const balance of [0, 20_000_000, 20_005_000, 20_500_000, 20_895_879]) {
    assert.throws(
      () => assertPayerCanCover("PayerKey", balance, required),
      /too little SOL/,
      `balance ${balance}`
    );
  }
  assert.doesNotThrow(() =>
    assertPayerCanCover("PayerKey", required, required)
  );
  assert.doesNotThrow(() =>
    assertPayerCanCover("PayerKey", 21_000_000, required)
  );
});

test("assertPayerCanCover names the wallet, the balance and the required amount", () => {
  assert.throws(
    () => assertPayerCanCover("PayerKey", 20_000_000, 20_895_880),
    (error: Error) =>
      error.message.includes("PayerKey") &&
      error.message.includes("20895880") &&
      error.message.includes("20000000") &&
      error.message.includes("solana airdrop 1 PayerKey --url devnet")
  );
});

// LIFECYCLE_ACCOUNT_BYTES must track the program's LEN constants.
test("LIFECYCLE_ACCOUNT_BYTES matches the LEN constants in state.rs", () => {
  const source = readFileSync(
    join(__dirname, "..", "programs", "hedwig_sol", "src", "state.rs"),
    "utf8"
  );
  const lens = [...source.matchAll(/pub const LEN: usize = ([^;]+);/g)].map(
    (m) => {
      assert.match(m[1], /^[0-9+() ]+$/);
      return Function(`return (${m[1]})`)() as number;
    }
  );
  assert.deepEqual(lens, [...LIFECYCLE_ACCOUNT_BYTES]);
});

// The revoke demo's own floor must cover what its run spends: three
// accounts, six signed transactions and a rent-exempt payer.
test("MIN_BALANCE_LAMPORTS covers the revoke demo's own spend", () => {
  const rentPerByteTwoYears = 6_960;
  const accountRent = (bytes: number) => (128 + bytes) * rentPerByteTwoYears;
  const required = requiredPayerLamports({
    spendLamports: LIFECYCLE_ACCOUNT_BYTES.map(accountRent).reduce(
      (sum, rent) => sum + rent,
      0
    ),
    signatures: 6,
    rentExemptMinimumLamports: RENT_EXEMPT_ZERO_DATA,
  });
  assert.ok(
    MIN_BALANCE_LAMPORTS >= required,
    `${MIN_BALANCE_LAMPORTS} < ${required}`
  );
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
  assert.equal(REAL_ASK4.proceed, false);
  assert.equal(REAL_ASK4.verdict, "DENY");
  assert.equal(REAL_ASK4.support, 0);
  assert.equal(REAL_ASK4.roleCode, "ROLE_MEMBER_MISSING");
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

// --- ask 1 / ask 4 verdict assertions, real fixtures + killing tests (H2) -

test("ask 1 is valid on the real ALLOW_UNDER_POLICY answer; ask 4 is valid on the real DENY answer", () => {
  assert.equal(isAsk1Valid(REAL_ASK1), true);
  assert.equal(isAsk4Valid(REAL_ASK4), true);
  assert.doesNotThrow(() => assertAsk1(REAL_ASK1));
  assert.doesNotThrow(() => assertAsk4(REAL_ASK4));
});

test("ask 1 is invalid on the real DENY answer, and ask 4 is invalid on the real allow answer", () => {
  assert.equal(isAsk1Valid(REAL_ASK4), false);
  assert.equal(isAsk4Valid(REAL_ASK1), false);
  assert.throws(() => assertAsk1(REAL_ASK4));
  assert.throws(() => assertAsk4(REAL_ASK1));
});

test("ask 4: UNKNOWN with ROLE_MEMBER_MISSING is invalid", () => {
  const ask: AskSummary = { ...REAL_ASK4, verdict: "UNKNOWN" };
  assert.equal(isAsk4Valid(ask), false);
});

test("ask 4: DENY with ROLE_DISABLED is invalid", () => {
  const ask: AskSummary = { ...REAL_ASK4, roleCode: "ROLE_DISABLED" };
  assert.equal(isAsk4Valid(ask), false);
});

test("ask 1: an allow verdict with ROLE_MEMBER_MISSING is invalid", () => {
  const ask: AskSummary = { ...REAL_ASK1, roleCode: "ROLE_MEMBER_MISSING" };
  assert.equal(isAsk1Valid(ask), false);
});

test("ask 4: DENY with proceed:true is invalid", () => {
  const ask: AskSummary = { ...REAL_ASK4, proceed: true };
  assert.equal(isAsk4Valid(ask), false);
});

test("ask 1: proceed:true with ROLE_NOT_REQUIRED is invalid", () => {
  const ask: AskSummary = { ...REAL_ASK1, roleCode: "ROLE_NOT_REQUIRED" };
  assert.equal(isAsk1Valid(ask), false);
});

test("ask 4: proceed:false with ROLE_HELD is invalid", () => {
  const ask: AskSummary = { ...REAL_ASK4, roleCode: "ROLE_HELD" };
  assert.equal(isAsk4Valid(ask), false);
});

// --- over-cap and missing-fact asks, real fixtures ------------------------

test("PAY_REQUEST_OVER_CAP keeps every field but amount, which the base cap can never cover", () => {
  assert.notEqual(
    PAY_REQUEST_OVER_CAP.action.amount,
    PAY_REQUEST.action.amount
  );
  assert.equal(
    BigInt(PAY_REQUEST_OVER_CAP.action.amount) > BigInt("1000000"),
    true
  );
  assert.equal(PAY_REQUEST_OVER_CAP.action.type, PAY_REQUEST.action.type);
  assert.equal(PAY_REQUEST_OVER_CAP.action.chainId, PAY_REQUEST.action.chainId);
  assert.equal(
    PAY_REQUEST_OVER_CAP.action.recipient,
    PAY_REQUEST.action.recipient
  );
  assert.deepEqual(PAY_REQUEST_OVER_CAP.action.asset, PAY_REQUEST.action.asset);
  assert.equal(PAY_REQUEST_OVER_CAP.action.target, PAY_REQUEST.action.target);
});

test("buildPolicyFileWithUnrecognizedRoleProgram keeps role and holder, swaps only programId", () => {
  const policy = buildPolicyFileWithUnrecognizedRoleProgram({
    programId: "H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC",
    role: "RoLePDA111111111111111111111111111",
    holder: "HoLdErPubKey1111111111111111111111",
  });
  assert.equal(policy.role.programId, UNRECOGNIZED_ROLE_PROGRAM_ID);
  assert.equal(policy.role.role, "RoLePDA111111111111111111111111111");
  assert.equal(policy.role.holder, "HoLdErPubKey1111111111111111111111");
});

test("the real over-cap fixture is a valid over-cap ask; the real allow and deny fixtures are not", () => {
  assert.equal(isOverCapAskValid(REAL_OVER_CAP_ASK), true);
  assert.doesNotThrow(() => assertOverCapAsk(REAL_OVER_CAP_ASK));
  assert.equal(isOverCapAskValid(REAL_ASK1), false);
  assert.equal(isOverCapAskValid(REAL_ASK4), false);
  assert.throws(() => assertOverCapAsk(REAL_ASK1));
});

test("the real missing-fact fixture is a valid missing-fact ask; the real allow and deny fixtures are not", () => {
  assert.equal(isMissingFactAskValid(REAL_MISSING_FACT_ASK), true);
  assert.doesNotThrow(() => assertMissingFactAsk(REAL_MISSING_FACT_ASK));
  assert.equal(isMissingFactAskValid(REAL_ASK1), false);
  assert.equal(isMissingFactAskValid(REAL_ASK4), false);
  assert.throws(() => assertMissingFactAsk(REAL_ASK4));
});

test("over-cap ask: DENY with the role missing rather than held is invalid (must be the cap, not the role)", () => {
  const ask: AskSummary = {
    ...REAL_OVER_CAP_ASK,
    roleCode: "ROLE_MEMBER_MISSING",
  };
  assert.equal(isOverCapAskValid(ask), false);
});

test("over-cap ask: DENY with the role still held but no cap code is invalid (the cap check must run, not just pass by role)", () => {
  const ask: AskSummary = { ...REAL_OVER_CAP_ASK, capCode: undefined };
  assert.equal(isOverCapAskValid(ask), false);
  const wrongCapCode: AskSummary = {
    ...REAL_OVER_CAP_ASK,
    capCode: "AMOUNT_WITHIN_CAP",
  };
  assert.equal(isOverCapAskValid(wrongCapCode), false);
});

test("over-cap ask: proceed:true is invalid even with a correct cap and role code", () => {
  const ask: AskSummary = { ...REAL_OVER_CAP_ASK, proceed: true };
  assert.equal(isOverCapAskValid(ask), false);
});

test("over-cap ask: a verdict other than DENY is invalid even with a correct cap and role code", () => {
  const ask: AskSummary = { ...REAL_OVER_CAP_ASK, verdict: "UNKNOWN" };
  assert.equal(isOverCapAskValid(ask), false);
});

test("missing-fact ask: proceed:true is invalid even with a correct role code", () => {
  const ask: AskSummary = { ...REAL_MISSING_FACT_ASK, proceed: true };
  assert.equal(isMissingFactAskValid(ask), false);
});

test("missing-fact ask: a verdict other than UNKNOWN is invalid even with a correct role code", () => {
  const ask: AskSummary = { ...REAL_MISSING_FACT_ASK, verdict: "DENY" };
  assert.equal(isMissingFactAskValid(ask), false);
});

test("missing-fact ask: UNKNOWN via a stale role fact rather than a missing one is invalid", () => {
  const ask: AskSummary = {
    ...REAL_MISSING_FACT_ASK,
    roleCode: "ROLE_FACT_STALE",
  };
  assert.equal(isMissingFactAskValid(ask), false);
});

test("withSwappedPolicyFile restores the original policy on disk even when action throws", async () => {
  const dir = scratchDir("hedwig-policy-swap-");
  const policyPath = join(dir, "policy.json");
  const original = { role: { programId: "ORIGINAL" } };
  const temporary = { role: { programId: "11111111111111111111111111111111" } };
  writeFileSync(policyPath, JSON.stringify(original));

  await assert.rejects(
    () =>
      withSwappedPolicyFile(policyPath, temporary, original, async () => {
        assert.equal(
          JSON.parse(readFileSync(policyPath, "utf8")).role.programId,
          temporary.role.programId
        );
        throw new Error("action failed mid-swap");
      }),
    /action failed mid-swap/
  );

  assert.deepEqual(JSON.parse(readFileSync(policyPath, "utf8")), original);
  rmSync(dir, { recursive: true, force: true });
});

test("withSwappedPolicyFile refuses a symlinked policy path, never writing through it", async () => {
  const dir = scratchDir("hedwig-policy-symlink-");
  const outsideDir = scratchDir("hedwig-policy-outside-");
  const outsideTarget = join(outsideDir, "real.json");
  const outsideContent = JSON.stringify({ role: { programId: "OUTSIDE" } });
  writeFileSync(outsideTarget, outsideContent, { mode: 0o644 });
  const policyPath = join(dir, "policy.json");
  symlinkSync(outsideTarget, policyPath);

  await assert.rejects(
    () =>
      withSwappedPolicyFile(
        policyPath,
        { role: { programId: "TEMP" } },
        { role: { programId: "ORIGINAL" } },
        async () => "should never run"
      ),
    /refusing to write a policy file through a symlink/
  );

  assert.equal(readFileSync(outsideTarget, "utf8"), outsideContent);
  assert.equal(statSync(outsideTarget).mode & 0o777, 0o644);

  rmSync(dir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

test("withSwappedPolicyFile writes both the swap and the restore at mode 600, even over a looser existing mode", async () => {
  const dir = scratchDir("hedwig-policy-mode-");
  const policyPath = join(dir, "policy.json");
  writeFileSync(
    policyPath,
    JSON.stringify({ role: { programId: "ORIGINAL" } }),
    {
      mode: 0o644,
    }
  );

  await withSwappedPolicyFile(
    policyPath,
    { role: { programId: "TEMP" } },
    { role: { programId: "ORIGINAL" } },
    async () => {
      assert.equal(statSync(policyPath).mode & 0o777, 0o600);
      return "ok";
    }
  );

  assert.equal(statSync(policyPath).mode & 0o777, 0o600);
  rmSync(dir, { recursive: true, force: true });
});

test("withSwappedPolicyFile reports the real open error, not a symlink refusal, for a missing policy file", async () => {
  const dir = scratchDir("hedwig-policy-missing-");
  const policyPath = join(dir, "does-not-exist.json");

  await assert.rejects(
    () =>
      withSwappedPolicyFile(
        policyPath,
        { role: { programId: "TEMP" } },
        { role: { programId: "ORIGINAL" } },
        async () => "should never run"
      ),
    (err: unknown) => {
      assert.equal(/symlink/i.test((err as Error).message), false);
      assert.equal((err as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    }
  );

  rmSync(dir, { recursive: true, force: true });
});

test("withSwappedPolicyFile surfaces both errors, action and restore, when the restore write also fails", async () => {
  const dir = scratchDir("hedwig-policy-restore-fail-");
  const policyPath = join(dir, "policy.json");
  writeFileSync(
    policyPath,
    JSON.stringify({ role: { programId: "ORIGINAL" } })
  );

  await assert.rejects(
    () =>
      withSwappedPolicyFile(
        policyPath,
        { role: { programId: "TEMP" } },
        { role: { programId: "ORIGINAL" } },
        async () => {
          // Remove the directory so the catch block's restore write fails
          // too; both the action's error and the restore's error must be
          // visible on the thrown AggregateError, not just one of them.
          rmSync(dir, { recursive: true, force: true });
          throw new Error("action failed and the restore will too");
        }
      ),
    (err: unknown) => {
      assert.equal(err instanceof AggregateError, true);
      const agg = err as AggregateError;
      assert.equal(agg.errors.length, 2);
      assert.match(
        agg.errors[0].message,
        /action failed and the restore will too/
      );
      assert.equal(agg.errors[1] instanceof Error, true);
      assert.match(agg.message, /action failed and the restore will too/);
      return true;
    }
  );
});

test("withSwappedPolicyFile restores the original policy on disk after a normal return", async () => {
  const dir = scratchDir("hedwig-policy-swap-");
  const policyPath = join(dir, "policy.json");
  const original = { role: { programId: "ORIGINAL" } };
  const temporary = { role: { programId: "11111111111111111111111111111111" } };
  writeFileSync(policyPath, JSON.stringify(original));

  const result = await withSwappedPolicyFile(
    policyPath,
    temporary,
    original,
    async () => "ok"
  );

  assert.equal(result, "ok");
  assert.deepEqual(JSON.parse(readFileSync(policyPath, "utf8")), original);
  rmSync(dir, { recursive: true, force: true });
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
    overCapAsk: REAL_OVER_CAP_ASK,
    missingFactAsk: REAL_MISSING_FACT_ASK,
    ask4: REAL_ASK4,
    ask4FirstAttempt: undefined,
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
      "Ask 1 and Ask 4: same server process, same policy file, same request. Only the role changed."
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
    overCapAsk: REAL_OVER_CAP_ASK,
    missingFactAsk: REAL_MISSING_FACT_ASK,
    ask4: REAL_ASK4,
    ask4FirstAttempt: undefined,
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
    overCapAsk: REAL_OVER_CAP_ASK,
    missingFactAsk: REAL_MISSING_FACT_ASK,
    ask4: REAL_ASK4,
  };

  const lagOutput = formatTranscript({
    ...base,
    ask1: REAL_ASK1,
    ask4FirstAttempt: REAL_ASK1, // still ROLE_HELD: a genuine lag
  });
  assert.equal(lagOutput.includes("RPC lag"), true);
  assert.equal(lagOutput.includes("retried Ask 4"), true);
  assert.equal(lagOutput.includes("retried Ask 2"), false);

  const failureFirstAttempt: AskSummary = {
    ...REAL_ASK4,
    verdict: "UNKNOWN",
    roleCode: "ROLE_FACT_MISSING",
  };
  const failureOutput = formatTranscript({
    ...base,
    ask1: REAL_ASK1,
    ask4FirstAttempt: failureFirstAttempt,
  });
  assert.equal(failureOutput.includes("RPC lag"), false);
  assert.equal(failureOutput.includes("not a lag"), true);
  assert.equal(failureOutput.includes("ROLE_FACT_MISSING"), true);
});

// --- the machine-readable --out record: public facts only (B4) -----------

test("buildMachineRecord never includes the policy path, env, keypair path or full RPC URL", () => {
  const record = buildMachineRecord({
    commit: "0123456789abcdef0123456789abcdef01234567",
    treeClean: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:05.000Z",
    rpcUrl: "https://rpc.example.com/CANARY-PATH?api-key=CANARY-KEY",
    programId: "ProgramPubkey11111111111111111111111",
    admin: "AdminPubkey111111111111111111111111",
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
    overCapAsk: { pid: 111, message: { CANARY: "CANARY-OVERCAP" } },
    missingFactAsk: { pid: 111, message: { CANARY: "CANARY-MISSINGFACT" } },
    ask4: { pid: 111, message: { CANARY: "CANARY-ASK4" } },
    ask4FirstAttempt: undefined,
  });
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("CANARY-PATH"), false);
  assert.equal(serialized.includes("CANARY-KEY"), false);
  assert.equal(record.rpcHost, "rpc.example.com");
  // The source commit, the source-tree flag, the times and the ids the
  // evidence doc copies are passed through as given.
  assert.equal(record.commit, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(record.treeClean, true);
  assert.equal(record.startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(record.finishedAt, "2026-01-01T00:00:05.000Z");
  assert.equal(record.programId, "ProgramPubkey11111111111111111111111");
  assert.equal(record.admin, "AdminPubkey111111111111111111111111");
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

// The path guard runs before any read: a loose-mode wallet file under a
// denied directory is refused for its location, never for its mode. A
// mode error here would mean the file had already been opened.
test("loadOrGenerateKeypair refuses a denied location before it looks at the file", () => {
  const fakeHome = scratchDir("hedwig-revoke-demo-guard-first-home-");
  try {
    const solanaDir = join(fakeHome, ".config", "solana");
    mkdirSync(solanaDir, { recursive: true });
    const candidate = join(solanaDir, "id.json");
    writeFileSync(candidate, "[0]", { mode: 0o644 });
    assert.throws(
      () => loadOrGenerateKeypair(candidate, fakeHome),
      /denied directory|wallet/
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// The read itself never follows a link, even when the guard is bypassed by
// calling the reader directly with a symlink to a well-formed 600 file.
test("readExistingKeypair refuses a symlink to a valid 600 key file", () => {
  const dir = scratchDir("hedwig-revoke-demo-read-nofollow-");
  try {
    const target = join(dir, "real.json");
    writeFileSync(
      target,
      JSON.stringify(Array.from(Keypair.generate().secretKey)),
      {
        mode: 0o600,
      }
    );
    const link = join(dir, "link.json");
    symlinkSync(target, link);
    assert.throws(() => readExistingKeypair(link));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- fail-closed demo key and cluster selection ---------------------------

test("resolveKeypairPath uses the default only when HEDWIG_DEMO_KEYPAIR is unset", () => {
  const resolved = resolveKeypairPath({});
  assert.equal(resolved.path, DEFAULT_KEYPAIR_PATH);
  assert.equal(resolved.source, "default");
});

test("resolveKeypairPath returns an explicit absolute value as given", () => {
  const explicit = join(sep, "var", "hedwig-demo", "key.json");
  const resolved = resolveKeypairPath({ HEDWIG_DEMO_KEYPAIR: explicit });
  assert.equal(resolved.path, explicit);
  assert.equal(resolved.source, "explicit");
});

test("resolveKeypairPath takes a caller-supplied default for its own demo", () => {
  const own = join(sep, "var", "hedwig-demo", "own-default.json");
  const resolved = resolveKeypairPath({}, own);
  assert.equal(resolved.path, own);
  assert.equal(resolved.source, "default");
});

test("resolveKeypairPath refuses an empty or whitespace-only value instead of falling back", () => {
  for (const value of ["", " ", "   ", "\t", "\n"]) {
    assert.throws(
      () => resolveKeypairPath({ HEDWIG_DEMO_KEYPAIR: value }),
      /HEDWIG_DEMO_KEYPAIR/,
      JSON.stringify(value)
    );
  }
});

test("resolveKeypairPath refuses a relative or home-shorthand path", () => {
  for (const value of ["key.json", "./key.json", "../key.json", "~/key.json"]) {
    assert.throws(
      () => resolveKeypairPath({ HEDWIG_DEMO_KEYPAIR: value }),
      /absolute/,
      value
    );
  }
});

test("assertDevnetGenesisHash refuses mainnet-beta's genesis hash", () => {
  const MAINNET_BETA_GENESIS_HASH =
    "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  assert.throws(
    () => assertDevnetGenesisHash(MAINNET_BETA_GENESIS_HASH),
    /not Solana devnet/
  );
});

test("each demo has its own default key file, none under the guard's denied directories", () => {
  const defaults = [
    DEFAULT_KEYPAIR_PATH,
    LIFECYCLE_DEMO_KEYPAIR_PATH,
    CONSUMER_DEMO_KEYPAIR_PATH,
  ];
  assert.equal(new Set(defaults).size, 3);
  for (const candidate of defaults) {
    assert.doesNotThrow(() => assertKeypairPathAllowed(candidate));
  }
});

const SIGNING_DEMOS = ["demo.ts", "consumer-demo.ts", "revoke-demo.ts"];

function demoSource(file: string): string {
  return readFileSync(join(__dirname, file), "utf8");
}

test("demo.ts and consumer-demo.ts never read ANCHOR_WALLET or the Solana CLI config directory", () => {
  for (const file of ["demo.ts", "consumer-demo.ts"]) {
    const source = demoSource(file);
    assert.equal(source.includes("ANCHOR_WALLET"), false, file);
    assert.equal(source.includes(".config"), false, file);
    assert.equal(source.includes("id.json"), false, file);
  }
});

test("every signing demo resolves its key path through resolveKeypairPath and loads it through loadOrGenerateKeypair", () => {
  for (const file of SIGNING_DEMOS) {
    const source = demoSource(file);
    assert.match(source, /\bresolveKeypairPath\(/, file);
    assert.match(source, /\bloadOrGenerateKeypair\(/, file);
    assert.equal(source.includes("readFileSync"), false, file);
  }
});

test("every signing demo checks the genesis hash before it loads a key", () => {
  for (const file of SIGNING_DEMOS) {
    const source = demoSource(file);
    const check = source.search(/\bassertDevnetGenesisHash\(/);
    const load = source.search(/\bloadOrGenerateKeypair\(/);
    assert.notEqual(check, -1, `${file} never checks the genesis hash`);
    assert.notEqual(load, -1, `${file} never loads a key`);
    assert.ok(check < load, `${file} loads a key before the genesis check`);
  }
});

test("every signing demo reads the genesis hash from the connection it signs on", () => {
  for (const file of SIGNING_DEMOS) {
    assert.match(
      demoSource(file),
      /assertDevnetGenesisHash\(\s*await connection\.getGenesisHash\(\)\s*\)|assertDevnetGenesisHash\(genesisHash\)/,
      file
    );
  }
});

// The two demos that fund from a payer check the full floor, not `=== 0` or
// the spend alone.
test("the lifecycle and consumer demos gate on assertPayerCanCover", () => {
  for (const file of ["demo.ts", "consumer-demo.ts"]) {
    const source = demoSource(file);
    assert.match(source, /assertPayerCanCover\(/, file);
    assert.match(source, /getMinimumBalanceForRentExemption\(0\)/, file);
  }
});
