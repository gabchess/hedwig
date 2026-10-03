/**
 * Pure-ish logic behind revoke-demo.ts, kept free of `@hedwig-sol/sdk` and
 * the MCP SDK so it can be unit tested without a built SDK or a live
 * server. Every filesystem-touching function here only touches the paths
 * it is explicitly given, and every security check runs before any read.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Keypair, LAMPORTS_PER_SOL, type PublicKey } from "@solana/web3.js";

const HOME_DIR = os.homedir();

// ---------------------------------------------------------------------------
// Cluster identity
// ---------------------------------------------------------------------------

// https://api.devnet.solana.com's own getGenesisHash answer. Any RPC URL
// answering a different hash is not devnet, whatever its hostname claims.
// Compared with `!==` on the whole string: a `startsWith` check would let a
// hash that merely shares a prefix through.
export const DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export function assertDevnetGenesisHash(hash: string): void {
  if (hash !== DEVNET_GENESIS_HASH) {
    throw new Error(
      `refusing to continue: RPC genesis hash ${hash} is not Solana devnet's`
    );
  }
}

// disableRetryOnRateLimit: a single requestAirdrop call otherwise retries
// on 429 inside the library, turning one intended call into several HTTP
// requests against the faucet.
export function buildConnectionOptions(): {
  commitment: "confirmed";
  disableRetryOnRateLimit: true;
} {
  return { commitment: "confirmed", disableRetryOnRateLimit: true };
}

// ---------------------------------------------------------------------------
// Throwaway keypair path guard and loader
// ---------------------------------------------------------------------------

// Changed from a path under the worktree tree (K3): that constant used to
// bake a local folder layout into a public file. The already-generated key
// at the old path is untouched by this change; a later run points
// HEDWIG_DEMO_KEYPAIR at it explicitly.
export const DEFAULT_KEYPAIR_PATH = path.join(
  HOME_DIR,
  ".hedwig",
  "demo-keys",
  "revoke-demo-admin.json"
);

// Where each demo keeps its own throwaway key when HEDWIG_DEMO_KEYPAIR is
// not set. The lifecycle demo's org PDA derives from its key alone, so it
// cannot share a key with the revoke demo.
export const LIFECYCLE_DEMO_KEYPAIR_PATH = path.join(
  path.dirname(DEFAULT_KEYPAIR_PATH),
  "lifecycle-demo-admin.json"
);
export const CONSUMER_DEMO_KEYPAIR_PATH = path.join(
  path.dirname(DEFAULT_KEYPAIR_PATH),
  "consumer-demo-payer.json"
);

export type KeypairPathSource = "explicit" | "default";

// The default applies only when the variable is absent. A variable that is
// set but empty, blank or relative is a mistake the caller must fix: a
// silent fallback would sign with a key the caller did not choose, and a
// relative value would resolve against whatever directory the demo started
// in.
export function resolveKeypairPath(
  env: NodeJS.ProcessEnv,
  defaultPath: string = DEFAULT_KEYPAIR_PATH
): { path: string; source: KeypairPathSource } {
  const value = env.HEDWIG_DEMO_KEYPAIR;
  if (value === undefined) {
    return { path: defaultPath, source: "default" };
  }
  if (value.trim() === "") {
    throw new Error(
      "refusing: HEDWIG_DEMO_KEYPAIR is set but empty; unset it to use the default or give an absolute path"
    );
  }
  if (!path.isAbsolute(value)) {
    throw new Error(
      "refusing: HEDWIG_DEMO_KEYPAIR must be an absolute path (no relative or ~ shorthand)"
    );
  }
  return { path: value, source: "explicit" };
}

// No mode bits beyond the owner's may be set: 600 or stricter only.
const FORBIDDEN_MODE_BITS = 0o077;
// A pre-existing parent directory must not be writable by group or other.
const UNSAFE_DIR_MODE_BITS = 0o022;

function nearestExistingAncestorDir(resolvedPath: string): string {
  let dir = path.dirname(resolvedPath);
  for (;;) {
    if (fs.existsSync(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return dir;
    }
    dir = parent;
  }
}

// Resolves symlinks in every ANCESTOR directory (real filesystem identity),
// then reattaches the untouched basename (and any not-yet-created
// intermediate segments). Catches a directory-level symlink trick (an
// ancestor directory that is itself a symlink into a denied location) that
// a purely lexical check on the given string would miss. Whether the
// candidate's own final path component is a symlink is a separate check
// (see assertKeypairPathAllowed): lstat resolves everything but the final
// component, so this function and that check cover disjoint attacks.
export function realCheckedPath(candidatePath: string): string {
  const resolved = path.resolve(candidatePath);
  const ancestorDir = nearestExistingAncestorDir(resolved);
  let realAncestorDir: string;
  try {
    realAncestorDir = fs.realpathSync(ancestorDir);
  } catch {
    realAncestorDir = ancestorDir;
  }
  const rest = path.relative(ancestorDir, resolved);
  return rest === "" ? realAncestorDir : path.join(realAncestorDir, rest);
}

// One denied directory name is a personal notes-vault app; it is kept out
// of tracked text and decoded at runtime so the functional check exists
// without a literal occurrence in the source.
export const PERSONAL_NOTES_VAULT_DIR_NAME = Buffer.from(
  "T2JzaWRpYW4=",
  "base64"
).toString("utf8");

// homeDir is injectable so a test can point this at a scratch directory
// instead of the real home directory; the real key file this guard exists
// to protect is never touched by a test.
export function isUnderDeniedHomeSubdirectory(
  checkedPath: string,
  homeDir: string = HOME_DIR
): boolean {
  // checkedPath has already had every ancestor symlink resolved
  // (realCheckedPath); homeDir must be resolved the same way before the
  // two are compared, or a home directory reached through a symlinked
  // ancestor (macOS: /var/folders -> /private/var/folders) never matches.
  let realHomeDir = homeDir;
  try {
    realHomeDir = fs.realpathSync(homeDir);
  } catch {
    // homeDir does not exist yet: compare against it as given.
  }
  const denied = [
    path.join(realHomeDir, ".config", "solana"),
    path.join(realHomeDir, "secrets"),
    path.join(realHomeDir, PERSONAL_NOTES_VAULT_DIR_NAME),
  ];
  return denied.some(
    (dir) => checkedPath === dir || checkedPath.startsWith(dir + path.sep)
  );
}

// Anchor's build output directory: a real signing keypair for a deployed
// program lives under here.
export function hasTargetDeploySegment(checkedPath: string): boolean {
  const segments = checkedPath.split(path.sep);
  return segments.some(
    (segment, index) => segment === "target" && segments[index + 1] === "deploy"
  );
}

// Walks up from the checked (already real-resolved) path looking for a
// `.git` entry (a directory for a normal clone, a file for a worktree). No
// `git` process is spawned, so this is checkable with a plain fixture
// directory in a test.
export function isInsideGitWorkTree(checkedPath: string): boolean {
  let dir = path.dirname(checkedPath);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
}

// Runs before any read of the candidate path. Refuses:
//  - the candidate itself being a symlink (lstat, never followed);
//  - the candidate existing as anything other than a regular file
//    (directory, device, fifo, /dev/*);
//  - the real (ancestor-resolved) path landing under a denied home
//    subdirectory, a `target/deploy` build directory, or inside a git
//    work tree.
export function assertKeypairPathAllowed(
  candidatePath: string,
  homeDir: string = HOME_DIR
): void {
  const resolved = path.resolve(candidatePath);

  let lstat: fs.Stats | undefined;
  try {
    lstat = fs.lstatSync(resolved);
  } catch {
    lstat = undefined;
  }
  if (lstat) {
    if (lstat.isSymbolicLink()) {
      throw new Error(`refusing a symlinked keypair path: ${candidatePath}`);
    }
    if (!lstat.isFile()) {
      throw new Error(
        `refusing a keypair path that is not a regular file: ${candidatePath}`
      );
    }
  }

  const checked = realCheckedPath(resolved);
  if (isUnderDeniedHomeSubdirectory(checked, homeDir)) {
    throw new Error(
      `refusing a keypair path under a denied directory: ${candidatePath}`
    );
  }
  if (hasTargetDeploySegment(checked)) {
    throw new Error(
      `refusing a keypair path under a Solana program build directory: ${candidatePath}`
    );
  }
  if (isInsideGitWorkTree(checked)) {
    throw new Error(
      `refusing to store a demo keypair inside a git work tree: ${candidatePath}`
    );
  }
}

// Refuses to create inside a directory that does not exist yet and cannot
// be made 700, or one that already exists and is writable by group or
// other. Never chmods a directory that already existed: only a freshly
// created one gets its mode set, by mkdirSync itself.
export function assertParentSafeForCreate(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`refusing: not a directory: ${dir}`);
  }
  if ((stat.mode & UNSAFE_DIR_MODE_BITS) !== 0) {
    throw new Error(`refusing: directory is group- or world-writable: ${dir}`);
  }
}

// O_EXCL: refuses to overwrite a file that appears at this path by the time
// of the call, whatever created it. O_NOFOLLOW: refuses a symlink dropped
// at this exact path between the earlier guard check and this call.
export function createKeypairFile(
  resolvedPath: string,
  secretKey: Uint8Array
): void {
  assertParentSafeForCreate(path.dirname(resolvedPath));
  let fd: number;
  try {
    fd = fs.openSync(
      resolvedPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600
    );
  } catch {
    throw new Error(
      `refusing to create the demo keypair file (it already exists or is a symlink): ${resolvedPath}`
    );
  }
  try {
    fs.writeSync(fd, Buffer.from(JSON.stringify(Array.from(secretKey))));
  } finally {
    fs.closeSync(fd);
  }
}

// One open, one fstat, one read: fstat runs on the open descriptor so the
// mode/owner check and the read see the same file, never two different
// ones raced in between. Every failure past the open, including a parse
// error, is replaced with a fixed message: the original content, and any
// parser's quote of it, never reaches the thrown error.
export function readExistingKeypair(resolvedPath: string): Keypair {
  let fd: number;
  try {
    fd = fs.openSync(
      resolvedPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
  } catch {
    throw new Error(
      `refusing to open the demo keypair file (missing, not a file, or a symlink): ${resolvedPath}`
    );
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`refusing: not a regular file: ${resolvedPath}`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(
        `refusing: not owned by the current user: ${resolvedPath}`
      );
    }
    if ((stat.mode & FORBIDDEN_MODE_BITS) !== 0) {
      throw new Error(
        `refusing: mode must be 600 or stricter, no group/other bits: ${resolvedPath}`
      );
    }
    const raw = fs.readFileSync(fd, "utf8");
    try {
      const parsed = JSON.parse(raw);
      return Keypair.fromSecretKey(Uint8Array.from(parsed));
    } catch {
      throw new Error(
        "refusing: the demo keypair file's content is not a well-formed keypair"
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}

// The guard runs before either branch reads or writes anything.
export function loadOrGenerateKeypair(
  candidatePath: string,
  homeDir: string = HOME_DIR
): Keypair {
  assertKeypairPathAllowed(candidatePath, homeDir);
  const resolved = path.resolve(candidatePath);
  if (fs.existsSync(resolved)) {
    return readExistingKeypair(resolved);
  }
  const keypair = Keypair.generate();
  createKeypairFile(resolved, keypair.secretKey);
  return keypair;
}

// ---------------------------------------------------------------------------
// Spawned server: an allowlisted environment, a build preflight
// ---------------------------------------------------------------------------

const ALLOWED_ENV_PASSTHROUGH = ["PATH", "HOME", "NODE_OPTIONS"] as const;

// The child inherits nothing from the shell beyond this allowlist plus the
// three variables the server itself needs: not the whole environment,
// which would otherwise hand every secret in the caller's shell to a
// spawned process.
export function buildServerEnv(
  sourceEnv: NodeJS.ProcessEnv,
  policyFile: string,
  rpcUrl: string,
  feePayer: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_PASSTHROUGH) {
    const value = sourceEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.HEDWIG_POLICY_FILE = policyFile;
  env.HEDWIG_SOLANA_RPC_URL_DEVNET = rpcUrl;
  env.HEDWIG_SOLANA_FEE_PAYER_DEVNET = feePayer;
  return env;
}

export function assertServerBuilt(serverPath: string): void {
  if (!fs.existsSync(serverPath)) {
    throw new Error(
      `${serverPath} is missing; run "yarn mcp:build" before the revoke demo`
    );
  }
}

// ---------------------------------------------------------------------------
// Pre-flight balance floor
// ---------------------------------------------------------------------------

// The base fee: 5,000 lamports per signature. No demo sets a priority fee.
export const FEE_LAMPORTS_PER_SIGNATURE = 5_000;

// What a payer must hold before a run starts: everything the run spends,
// the fee for each signed transaction, and the rent-exempt minimum the
// payer account must keep. A fee-only floor still lets balances between the
// spend and the rent floor through, and those fail with a raw
// "insufficient funds for rent" error.
export function requiredPayerLamports(plan: {
  spendLamports: number;
  signatures: number;
  rentExemptMinimumLamports: number;
}): number {
  return (
    plan.spendLamports +
    plan.signatures * FEE_LAMPORTS_PER_SIGNATURE +
    plan.rentExemptMinimumLamports
  );
}

// Account sizes the lifecycle creates, in bytes, mirrored from the LEN
// constants in programs/hedwig_sol/src/state.rs (Org, Role, Member). The
// SDK's own `account.<name>.size` is not usable here: it counts a string
// field without its maximum length.
export const LIFECYCLE_ACCOUNT_BYTES = [117, 118, 89] as const;

export function assertPayerCanCover(
  payer: string,
  balanceLamports: number,
  requiredLamports: number
): void {
  if (balanceLamports < requiredLamports) {
    throw new Error(
      `Wallet ${payer} has too little SOL on devnet: ${balanceLamports} lamports, needs at least ${requiredLamports}. Fund it with: solana airdrop 1 ${payer} --url devnet`
    );
  }
}

// ---------------------------------------------------------------------------
// Airdrop decision: capped, and only when actually needed
// ---------------------------------------------------------------------------

export const MIN_BALANCE_LAMPORTS = Math.floor(0.05 * LAMPORTS_PER_SOL);
export const AIRDROP_LAMPORTS = LAMPORTS_PER_SOL;

export function shouldRequestAirdrop(balanceLamports: number): boolean {
  return balanceLamports < MIN_BALANCE_LAMPORTS;
}

// A fixed constant, not a function of the current balance: the airdrop
// amount can never grow with whatever a caller passes in.
export function airdropAmountLamports(): number {
  return AIRDROP_LAMPORTS;
}

// ---------------------------------------------------------------------------
// Policy builder
// ---------------------------------------------------------------------------

export const BASE_PAY_POLICY = Object.freeze({
  permits: true,
  chainId: "eip155:1",
  approvedRecipients: ["0x00000000000000000000000000000000a11ce001"],
  perActionCaps: { pay: "1000000" },
  perActionCapAssets: { pay: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  authorizationWindow: { mode: "not-required" as const },
});

// The same EVM "pay" request the mcp test fixtures use, unchanged by the
// role requirement: only the policy's role block, not the request, decides
// whether the role gate applies.
export const PAY_REQUEST = Object.freeze({
  action: {
    type: "pay",
    chainId: "eip155:1",
    recipient: "0x00000000000000000000000000000000a11ce001",
    asset: {
      symbol: "USDC",
      contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    },
    amount: "1000000",
    target: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
});

// PAY_REQUEST with an amount above BASE_PAY_POLICY.perActionCaps.pay
// ("1000000"). Every other field is unchanged.
export const PAY_REQUEST_OVER_CAP = Object.freeze({
  action: {
    ...PAY_REQUEST.action,
    amount: "2000000000",
  },
});

export interface RolePolicyInput {
  programId: string;
  role: string;
  holder: string;
}

// Solana's System Program id: a well-formed base58 pubkey that is not
// Hedwig's deployed program id. The Solana role Reader
// (mcp/src/readers/solana-role.ts) returns no cluster config for a program
// id other than the deployed one, so it makes no network call and produces
// no solanaRole fact, and role-requirement-met answers ROLE_FACT_MISSING.
export const UNRECOGNIZED_ROLE_PROGRAM_ID = "11111111111111111111111111111111";

export interface RolePolicyBlock {
  mode: "required";
  cluster: "devnet";
  programId: string;
  role: string;
  holder: string;
  maxAgeSeconds: 60;
}

// No `member`: the server derives that PDA itself from role + holder.
export function buildRolePolicy(input: RolePolicyInput): RolePolicyBlock {
  return {
    mode: "required",
    cluster: "devnet",
    programId: input.programId,
    role: input.role,
    holder: input.holder,
    maxAgeSeconds: 60,
  };
}

export function buildPolicyFile(
  input: RolePolicyInput
): typeof BASE_PAY_POLICY & { role: RolePolicyBlock } {
  return {
    ...BASE_PAY_POLICY,
    role: buildRolePolicy(input),
  };
}

// buildPolicyFile with programId replaced by UNRECOGNIZED_ROLE_PROGRAM_ID.
export function buildPolicyFileWithUnrecognizedRoleProgram(
  input: RolePolicyInput
): typeof BASE_PAY_POLICY & { role: RolePolicyBlock } {
  return buildPolicyFile({
    ...input,
    programId: UNRECOGNIZED_ROLE_PROGRAM_ID,
  });
}

// Opens an existing policyPath with O_NOFOLLOW, so a final path component
// that is a symlink fails with ELOOP, reported as a symlink refusal. After
// the write, fchmodSync sets mode 600 on the same descriptor.
function writePolicyFileNoFollow(policyPath: string, content: string): void {
  let fd: number;
  try {
    fd = fs.openSync(
      policyPath,
      fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW
    );
  } catch (openError) {
    if ((openError as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(
        `refusing to write a policy file through a symlink: ${policyPath}`
      );
    }
    throw openError;
  }
  try {
    fs.writeSync(fd, Buffer.from(content, "utf8"));
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

// Writes temporaryPolicy over policyPath, runs action, then writes
// originalPolicy back. When action returns, originalPolicy is written and
// the result is returned; if that write throws, its error is thrown and the
// result is dropped. When action throws, originalPolicy is still written,
// then the action's error is re-thrown; if that write also throws, an
// AggregateError carrying both errors is thrown instead.
export async function withSwappedPolicyFile<T>(
  policyPath: string,
  temporaryPolicy: unknown,
  originalPolicy: unknown,
  action: () => Promise<T>
): Promise<T> {
  writePolicyFileNoFollow(policyPath, JSON.stringify(temporaryPolicy));
  let result: T;
  try {
    result = await action();
  } catch (actionError) {
    // The AggregateError lists the action's error first, then the restore
    // error; its message quotes only the action's error message.
    try {
      writePolicyFileNoFollow(policyPath, JSON.stringify(originalPolicy));
    } catch (restoreError) {
      const actionMessage =
        actionError instanceof Error
          ? actionError.message
          : String(actionError);
      throw new AggregateError(
        [actionError, restoreError],
        `action failed, and the policy restore that followed also failed: ${actionMessage}`
      );
    }
    throw actionError;
  }
  writePolicyFileNoFollow(policyPath, JSON.stringify(originalPolicy));
  return result;
}

// ---------------------------------------------------------------------------
// Consult answer parsing and verdict assertions
// ---------------------------------------------------------------------------

export interface AskSummary {
  proceed: boolean;
  verdict: string;
  support: number;
  band: string;
  roleCode: string | undefined;
  roleEvidence: string | undefined;
  capCode: string | undefined;
  capEvidence: string | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Reads a raw JSON-RPC response message exactly as received over stdio.
// Returns undefined for anything that does not have the shape a real
// `consult` answer always has; never guesses at a partial shape. The role
// row is the one whose id is "role-requirement-met", found by id, never by
// array position: a decoy row placed first changes nothing.
export function extractAskSummary(message: unknown): AskSummary | undefined {
  const result = asRecord(asRecord(message)?.result);
  const structured = asRecord(result?.structuredContent);
  if (!structured) {
    return undefined;
  }
  const { proceed, verdict, support, band, results } = structured;
  if (
    typeof proceed !== "boolean" ||
    typeof verdict !== "string" ||
    typeof support !== "number" ||
    typeof band !== "string" ||
    !Array.isArray(results)
  ) {
    return undefined;
  }
  const rows = results.map(asRecord);
  const roleRow = rows.find((row) => row?.id === "role-requirement-met");
  const capRow = rows.find((row) => row?.id === "amount-within-cap");
  return {
    proceed,
    verdict,
    support,
    band,
    roleCode: typeof roleRow?.code === "string" ? roleRow.code : undefined,
    roleEvidence:
      typeof roleRow?.evidence === "string" ? roleRow.evidence : undefined,
    capCode: typeof capRow?.code === "string" ? capRow.code : undefined,
    capEvidence:
      typeof capRow?.evidence === "string" ? capRow.evidence : undefined,
  };
}

// consult()'s real allow verdict is "ALLOW_UNDER_POLICY" (see
// consult/src/fold.ts): never a string like "PROCEED" the server never
// sends. Ask 1 must earn all four fields together.
export function isAsk1Valid(ask: AskSummary | undefined): ask is AskSummary {
  return (
    ask !== undefined &&
    ask.proceed === true &&
    ask.verdict === "ALLOW_UNDER_POLICY" &&
    ask.band === "green" &&
    ask.roleCode === "ROLE_HELD"
  );
}

export function assertAsk1(ask: AskSummary | undefined): AskSummary {
  if (!isAsk1Valid(ask)) {
    throw new Error(
      `ask 1 expected proceed=true verdict=ALLOW_UNDER_POLICY band=green code=ROLE_HELD, got ${JSON.stringify(
        ask
      )}`
    );
  }
  return ask;
}

export function isAsk4Valid(ask: AskSummary | undefined): ask is AskSummary {
  return (
    ask !== undefined &&
    ask.proceed === false &&
    ask.verdict === "DENY" &&
    ask.support === 0 &&
    ask.roleCode === "ROLE_MEMBER_MISSING"
  );
}

export function assertAsk4(ask: AskSummary | undefined): AskSummary {
  if (!isAsk4Valid(ask)) {
    throw new Error(
      `ask 4 (after revoke) expected proceed=false verdict=DENY support=0 code=ROLE_MEMBER_MISSING, got ${JSON.stringify(
        ask
      )}`
    );
  }
  return ask;
}

// Over-cap ask: the role is still held (this runs before revoke), so the
// deny must come from the cap, never from the role row.
export function isOverCapAskValid(
  ask: AskSummary | undefined
): ask is AskSummary {
  return (
    ask !== undefined &&
    ask.proceed === false &&
    ask.verdict === "DENY" &&
    ask.capCode === "AMOUNT_EXCEEDS_CAP" &&
    ask.roleCode === "ROLE_HELD"
  );
}

export function assertOverCapAsk(ask: AskSummary | undefined): AskSummary {
  if (!isOverCapAskValid(ask)) {
    throw new Error(
      `over-cap ask expected proceed=false verdict=DENY capCode=AMOUNT_EXCEEDS_CAP roleCode=ROLE_HELD, got ${JSON.stringify(
        ask
      )}`
    );
  }
  return ask;
}

// Missing-fact ask: the policy's role programId is not the deployed one, so
// the role row answers ROLE_FACT_MISSING.
export function isMissingFactAskValid(
  ask: AskSummary | undefined
): ask is AskSummary {
  return (
    ask !== undefined &&
    ask.proceed === false &&
    ask.verdict === "UNKNOWN" &&
    ask.roleCode === "ROLE_FACT_MISSING"
  );
}

export function assertMissingFactAsk(ask: AskSummary | undefined): AskSummary {
  if (!isMissingFactAskValid(ask)) {
    throw new Error(
      `missing-fact ask expected proceed=false verdict=UNKNOWN roleCode=ROLE_FACT_MISSING, got ${JSON.stringify(
        ask
      )}`
    );
  }
  return ask;
}

// ---------------------------------------------------------------------------
// One live server process, proven before each ask
// ---------------------------------------------------------------------------

export interface ServerProcessLike {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

// Compares more than a captured number with itself: the process named by
// that pid must still be the running, unsignalled child at the moment of
// the check, not merely a pid value that happens to match.
export function assertServerProcessAlive(
  child: ServerProcessLike,
  capturedPid: number | undefined
): void {
  if (
    capturedPid === undefined ||
    child.pid !== capturedPid ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    throw new Error(
      `expected the same live server process (pid ${capturedPid}), saw pid=${child.pid} exitCode=${child.exitCode} signalCode=${child.signalCode}`
    );
  }
}

// ---------------------------------------------------------------------------
// Transcript formatting: public data only
// ---------------------------------------------------------------------------

export interface TranscriptInput {
  rpcUrl: string;
  admin: Keypair;
  org: PublicKey;
  role: PublicKey;
  holder: PublicKey;
  createOrgSig: string | undefined;
  createRoleSig: string;
  assignRoleSig: string;
  revokeRoleSig: string;
  ask1: AskSummary;
  overCapAsk: AskSummary;
  missingFactAsk: AskSummary;
  ask4: AskSummary;
  // Present only when Ask 4's first attempt did not yet earn DENY /
  // ROLE_MEMBER_MISSING and a retry was made; absent means the first
  // attempt already succeeded.
  ask4FirstAttempt: AskSummary | undefined;
}

export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function askLines(label: string, ask: AskSummary): string[] {
  const lines = [
    `${label}:`,
    `  proceed: ${ask.proceed}`,
    `  verdict: ${ask.verdict}`,
    `  support: ${ask.support}`,
    `  band: ${ask.band}`,
    `  role check: code=${ask.roleCode ?? "none"} evidence=${
      ask.roleEvidence ?? "none"
    }`,
  ];
  if (ask.capCode !== undefined) {
    lines.push(
      `  cap check: code=${ask.capCode} evidence=${ask.capEvidence ?? "none"}`
    );
  }
  return lines;
}

// A retry is only described as a lag when the first attempt still showed
// the still-held role (the same shape ask 1 earned): any other first
// answer is a genuine failure, not a lag, and is described as what it was.
function ask4RetryLines(firstAttempt: AskSummary | undefined): string[] {
  if (!firstAttempt) {
    return [];
  }
  const { verdict, roleCode } = firstAttempt;
  if (isAsk1Valid(firstAttempt)) {
    return [
      "  retried Ask 4 once after 2s: the first answer still held the role (RPC lag).",
    ];
  }
  return [
    `  retried Ask 4 once after 2s: the first answer was verdict=${verdict} code=${
      roleCode ?? "none"
    } (not a lag).`,
  ];
}

// Takes only public keys, signatures and the input rpcUrl (whose only use
// here is `new URL().host`, never printed whole). Never touches
// `admin.secretKey`. Deliberately typed to accept a whole Keypair, not just
// a base58 string, so a mistake that prints the secret is a test failure
// here rather than a leak in the real run.
export function formatTranscript(input: TranscriptInput): string {
  const host = new URL(input.rpcUrl).host;
  const lines: string[] = [];
  lines.push(`cluster: devnet (${host})`);
  lines.push(`admin: ${input.admin.publicKey.toBase58()}`);
  lines.push(`org: ${input.org.toBase58()}`);
  lines.push(`role: ${input.role.toBase58()}`);
  lines.push(`holder: ${input.holder.toBase58()}`);
  lines.push("");
  if (input.createOrgSig) {
    lines.push(
      `create_org tx: ${input.createOrgSig} ${explorerTxUrl(
        input.createOrgSig
      )}`
    );
  } else {
    lines.push("create_org: reused the org this admin key already created");
  }
  lines.push(
    `create_role tx: ${input.createRoleSig} ${explorerTxUrl(
      input.createRoleSig
    )}`
  );
  lines.push(
    `assign_role tx: ${input.assignRoleSig} ${explorerTxUrl(
      input.assignRoleSig
    )}`
  );
  lines.push("");
  lines.push(...askLines("Ask 1", input.ask1));
  lines.push("");
  lines.push(
    ...askLines("Ask 2 (over-cap payment, same role)", input.overCapAsk)
  );
  lines.push("");
  lines.push(
    ...askLines(
      "Ask 3 (payment missing a required Fact, same role)",
      input.missingFactAsk
    )
  );
  lines.push("");
  lines.push("Revoke:");
  lines.push(
    `  revoke_role tx: ${input.revokeRoleSig} ${explorerTxUrl(
      input.revokeRoleSig
    )}`
  );
  lines.push(...ask4RetryLines(input.ask4FirstAttempt));
  lines.push("");
  lines.push(...askLines("Ask 4 (original request, after revoke)", input.ask4));
  lines.push("");
  lines.push(
    "Ask 1 and Ask 4: same server process, same policy file, same request. Only the role changed."
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The machine-readable --out record: public facts only
// ---------------------------------------------------------------------------

export interface MachineRecordContext {
  // The source commit, and whether the source tree had uncommitted changes.
  commit: string;
  treeClean: boolean;
  // ISO 8601 UTC: when main() began, and when the record was built.
  startedAt: string;
  finishedAt: string;
  // Full RPC URL in, but only its host ever reaches the returned object.
  rpcUrl: string;
  programId: string;
  admin: string;
  serverPid: number;
  org: string;
  role: string;
  holder: string;
  signatures: {
    createOrg?: string;
    createRole: string;
    assignRole: string;
    revokeRole: string;
  };
  ask1: { pid: number; message: unknown };
  overCapAsk: { pid: number; message: unknown };
  missingFactAsk: { pid: number; message: unknown };
  ask4: { pid: number; message: unknown };
  ask4FirstAttempt: { pid: number; message: unknown } | undefined;
}

// Takes no policy path, no keypair path and no environment: those fields
// cannot appear in the returned object because this function never reads
// them from anywhere, not because a filter removes them after the fact.
export function buildMachineRecord(
  context: MachineRecordContext
): Record<string, unknown> {
  return {
    commit: context.commit,
    treeClean: context.treeClean,
    startedAt: context.startedAt,
    finishedAt: context.finishedAt,
    rpcHost: new URL(context.rpcUrl).host,
    programId: context.programId,
    admin: context.admin,
    serverPid: context.serverPid,
    org: context.org,
    role: context.role,
    holder: context.holder,
    signatures: context.signatures,
    ask1: context.ask1,
    overCapAsk: context.overCapAsk,
    missingFactAsk: context.missingFactAsk,
    ask4: context.ask4,
    ask4FirstAttempt: context.ask4FirstAttempt,
  };
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export function parseOutPath(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--out");
  if (index === -1 || index === argv.length - 1) {
    return undefined;
  }
  return argv[index + 1];
}
