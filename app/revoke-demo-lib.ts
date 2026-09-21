/**
 * Pure logic behind revoke-demo.ts, kept free of `@hedwig-sol/sdk` and the
 * MCP SDK so it can be unit tested without a built SDK or a live server.
 * Every function here either has no side effects or touches only the
 * filesystem paths it is explicitly given.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Keypair, PublicKey } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Cluster identity
// ---------------------------------------------------------------------------

// https://api.devnet.solana.com's own getGenesisHash answer. Any RPC URL
// answering a different hash is not devnet, whatever its hostname claims.
export const DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export function assertDevnetGenesisHash(hash: string): void {
  if (hash !== DEVNET_GENESIS_HASH) {
    throw new Error(
      `refusing to continue: RPC genesis hash ${hash} is not Solana devnet's`
    );
  }
}

// ---------------------------------------------------------------------------
// Throwaway keypair path guard
// ---------------------------------------------------------------------------

export const DEFAULT_KEYPAIR_PATH = path.join(
  os.homedir(),
  "projects",
  "hedwig-worktrees",
  "_demo-keys",
  "revoke-demo-admin.json"
);

// Walks up from the candidate's directory looking for a `.git` entry (a
// directory for a normal clone, a file for a worktree). No `git` process is
// spawned, so this is checkable with a plain fixture directory in a test.
export function isInsideGitWorkTree(candidatePath: string): boolean {
  let dir = path.dirname(path.resolve(candidatePath));
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

export function isDefaultSolanaWalletPath(candidatePath: string): boolean {
  const resolved = path.resolve(candidatePath);
  const parts = resolved.split(path.sep);
  const base = parts.pop();
  const parentDir = parts.pop();
  const grandparentDir = parts.pop();
  return (
    base === "id.json" && parentDir === "solana" && grandparentDir === ".config"
  );
}

export function assertKeypairPathAllowed(candidatePath: string): void {
  if (isDefaultSolanaWalletPath(candidatePath)) {
    throw new Error(
      `refusing to use the user's Solana wallet path: ${candidatePath}`
    );
  }
  if (isInsideGitWorkTree(candidatePath)) {
    throw new Error(
      `refusing to store a demo keypair inside a git work tree: ${candidatePath}`
    );
  }
}

// ---------------------------------------------------------------------------
// Policy builder
// ---------------------------------------------------------------------------

export const BASE_PAY_POLICY = Object.freeze({
  permits: true,
  chainId: "eip155:1",
  approvedRecipients: ["0x00000000000000000000000000000000a11ce001"],
  perActionCaps: { pay: "1000000" },
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

export interface RolePolicyInput {
  programId: string;
  role: string;
  holder: string;
}

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
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Reads a raw JSON-RPC response message exactly as received over stdio.
// Returns undefined for anything that does not have the shape a real
// `consult` answer always has; never guesses at a partial shape.
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
  const roleRow = results
    .map(asRecord)
    .find((row) => row?.id === "role-requirement-met");
  return {
    proceed,
    verdict,
    support,
    band,
    roleCode: typeof roleRow?.code === "string" ? roleRow.code : undefined,
    roleEvidence:
      typeof roleRow?.evidence === "string" ? roleRow.evidence : undefined,
  };
}

export function isAsk1Valid(ask: AskSummary | undefined): ask is AskSummary {
  return (
    ask !== undefined && ask.proceed === true && ask.roleCode === "ROLE_HELD"
  );
}

export function assertAsk1(ask: AskSummary | undefined): AskSummary {
  if (!isAsk1Valid(ask)) {
    throw new Error(
      `ask 1 expected proceed=true with ROLE_HELD, got ${JSON.stringify(ask)}`
    );
  }
  return ask;
}

export function isAsk2Valid(ask: AskSummary | undefined): ask is AskSummary {
  return (
    ask !== undefined &&
    ask.verdict === "DENY" &&
    ask.roleCode === "ROLE_MEMBER_MISSING"
  );
}

export function assertAsk2(ask: AskSummary | undefined): AskSummary {
  if (!isAsk2Valid(ask)) {
    throw new Error(
      `ask 2 expected verdict=DENY with ROLE_MEMBER_MISSING, got ${JSON.stringify(
        ask
      )}`
    );
  }
  return ask;
}

// ---------------------------------------------------------------------------
// One server process, proven
// ---------------------------------------------------------------------------

export function assertSameServerProcess(
  firstPid: number | undefined,
  secondPid: number | undefined
): void {
  if (
    firstPid === undefined ||
    secondPid === undefined ||
    firstPid !== secondPid
  ) {
    throw new Error(
      `expected one server process across both calls, saw pid ${firstPid} then ${secondPid}`
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
  ask2: AskSummary;
  ask2RetryUsed: boolean;
}

export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function askLines(label: string, ask: AskSummary): string[] {
  return [
    `${label}:`,
    `  proceed: ${ask.proceed}`,
    `  verdict: ${ask.verdict}`,
    `  support: ${ask.support}`,
    `  band: ${ask.band}`,
    `  role check: code=${ask.roleCode ?? "none"} evidence=${
      ask.roleEvidence ?? "none"
    }`,
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
  lines.push("Revoke:");
  lines.push(
    `  revoke_role tx: ${input.revokeRoleSig} ${explorerTxUrl(
      input.revokeRoleSig
    )}`
  );
  if (input.ask2RetryUsed) {
    lines.push(
      "  retried Ask 2 once after 2s: the RPC node was lagging a slot"
    );
  }
  lines.push("");
  lines.push(...askLines("Ask 2", input.ask2));
  lines.push("");
  lines.push(
    "Same server process, same policy file, same request. Only the role changed."
  );
  return lines.join("\n");
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
