/**
 * Devnet revoke demo: one Hedwig org, one role, one MCP server process,
 * two "consult" calls either side of a real on-chain revoke_role.
 *
 * Uses a throwaway keypair this script generates and funds itself; it never
 * reads the caller's own Solana wallet. Usage: see app/README.md.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AnchorProvider, Wallet } from "@anchor-lang/core";
import {
  HEDWIG_PROGRAM_ID,
  deriveOrgPda,
  deriveRolePda,
  sendAssignRole,
  sendCreateOrg,
  sendCreateRole,
  sendRevokeRole,
} from "@hedwig-sol/sdk";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

import {
  assertAsk1,
  assertAsk2,
  assertDevnetGenesisHash,
  assertKeypairPathAllowed,
  assertSameServerProcess,
  buildPolicyFile,
  DEFAULT_KEYPAIR_PATH,
  extractAskSummary,
  formatTranscript,
  isAsk2Valid,
  parseOutPath,
  PAY_REQUEST,
  type AskSummary,
} from "./revoke-demo-lib";

const SERVER_PATH = path.join(__dirname, "..", "mcp", "dist", "server.js");
const MIN_BALANCE_LAMPORTS = Math.floor(0.05 * LAMPORTS_PER_SOL);
const AIRDROP_LAMPORTS = LAMPORTS_PER_SOL;
const RESPONSE_TIMEOUT_MS = 15_000;
const RETRY_WAIT_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadOrGenerateKeypair(candidatePath: string): Keypair {
  assertKeypairPathAllowed(candidatePath);
  if (fs.existsSync(candidatePath)) {
    const raw = fs.readFileSync(candidatePath, "utf-8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  const keypair = Keypair.generate();
  const dir = path.dirname(candidatePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(
    candidatePath,
    JSON.stringify(Array.from(keypair.secretKey)),
    { mode: 0o600 }
  );
  fs.chmodSync(candidatePath, 0o600);
  return keypair;
}

// Raw JSON-RPC-over-stdio, hand-rolled: app/ imports no MCP client library.
function sendLine(
  child: ChildProcessWithoutNullStreams,
  message: unknown
): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function waitForResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          (parsed as { id?: unknown }).id === id
        ) {
          cleanup();
          resolve(parsed);
          return;
        }
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for a response with id=${id}`));
    }, timeoutMs);
    function cleanup(): void {
      clearTimeout(timer);
      child.stdout.off("data", onData);
    }
    child.stdout.on("data", onData);
  });
}

async function initializeServer(
  child: ChildProcessWithoutNullStreams
): Promise<void> {
  sendLine(child, {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "hedwig-revoke-demo", version: "0.0.0" },
    },
  });
  await waitForResponse(child, 0, RESPONSE_TIMEOUT_MS);
  sendLine(child, { jsonrpc: "2.0", method: "notifications/initialized" });
}

let nextCallId = 1;
async function callConsult(
  child: ChildProcessWithoutNullStreams
): Promise<unknown> {
  const id = nextCallId++;
  sendLine(child, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "consult", arguments: { request: PAY_REQUEST } },
  });
  return waitForResponse(child, id, RESPONSE_TIMEOUT_MS);
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error("server did not exit after stdin closed"));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const rpcUrl = (
    process.env.HEDWIG_DEMO_RPC_URL || "https://api.devnet.solana.com"
  ).trim();
  const connection = new Connection(rpcUrl, "confirmed");

  const genesisHash = await connection.getGenesisHash();
  assertDevnetGenesisHash(genesisHash);

  const keypairPath = process.env.HEDWIG_DEMO_KEYPAIR || DEFAULT_KEYPAIR_PATH;
  const admin = loadOrGenerateKeypair(keypairPath);
  console.log(`cluster: devnet (${new URL(rpcUrl).host})`);
  console.log(`admin: ${admin.publicKey.toBase58()}`);

  const balance = await connection.getBalance(admin.publicKey);
  if (balance < MIN_BALANCE_LAMPORTS) {
    try {
      const airdropSig = await connection.requestAirdrop(
        admin.publicKey,
        AIRDROP_LAMPORTS
      );
      await connection.confirmTransaction(airdropSig, "confirmed");
    } catch (error) {
      console.error(`faucet public key: ${admin.publicKey.toBase58()}`);
      console.error(
        `faucet error: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      process.exit(1);
    }
  }

  let holder = Keypair.generate();
  while (holder.publicKey.equals(admin.publicKey)) {
    holder = Keypair.generate();
  }

  const wallet = new Wallet(admin);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const [orgPda] = deriveOrgPda(admin.publicKey);
  const roleName = `revoke-${Math.random().toString(36).slice(2, 10)}`;
  const [rolePda] = deriveRolePda(orgPda, roleName);

  // The org PDA is derived from the admin key alone, so a reused throwaway
  // admin key can only create it once, ever. A fresh role name each run
  // avoids colliding with a role from an earlier run under the same org.
  const existingOrg = await connection.getAccountInfo(orgPda);
  let createOrgSig: string | undefined;
  if (!existingOrg) {
    createOrgSig = await sendCreateOrg(
      provider,
      { authority: admin.publicKey, name: `revoke-demo-${Date.now()}` },
      { signers: [] }
    );
  }

  const createRoleSig = await sendCreateRole(
    provider,
    { org: orgPda, authority: admin.publicKey, name: roleName },
    { signers: [] }
  );
  const assignRoleSig = await sendAssignRole(
    provider,
    {
      role: rolePda,
      holder: holder.publicKey,
      admin: admin.publicKey,
      expiresAt: null,
    },
    { signers: [] }
  );

  const policy = buildPolicyFile({
    programId: HEDWIG_PROGRAM_ID.toBase58(),
    role: rolePda.toBase58(),
    holder: holder.publicKey.toBase58(),
  });
  const policyPath = path.join(
    os.tmpdir(),
    `hedwig-revoke-demo-policy-${process.pid}.json`
  );
  fs.writeFileSync(policyPath, JSON.stringify(policy));

  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = spawn(process.execPath, [SERVER_PATH], {
      env: {
        ...process.env,
        HEDWIG_POLICY_FILE: policyPath,
        HEDWIG_SOLANA_RPC_URL_DEVNET: rpcUrl,
        HEDWIG_SOLANA_FEE_PAYER_DEVNET: admin.publicKey.toBase58(),
      },
    });
    const serverPid = child.pid;

    await initializeServer(child);

    const ask1Message = await callConsult(child);
    const ask1 = assertAsk1(extractAskSummary(ask1Message));

    const revokeRoleSig = await sendRevokeRole(
      provider,
      { role: rolePda, holder: holder.publicKey, admin: admin.publicKey },
      { signers: [] }
    );

    let ask2Message = await callConsult(child);
    let ask2Summary = extractAskSummary(ask2Message);
    let ask2RetryUsed = false;
    if (!isAsk2Valid(ask2Summary)) {
      ask2RetryUsed = true;
      await sleep(RETRY_WAIT_MS);
      ask2Message = await callConsult(child);
      ask2Summary = extractAskSummary(ask2Message);
    }
    const ask2: AskSummary = assertAsk2(ask2Summary);

    assertSameServerProcess(serverPid, child.pid);

    const transcript = formatTranscript({
      rpcUrl,
      admin,
      org: orgPda,
      role: rolePda,
      holder: holder.publicKey,
      createOrgSig,
      createRoleSig,
      assignRoleSig,
      revokeRoleSig,
      ask1,
      ask2,
      ask2RetryUsed,
    });
    console.log(transcript);

    const outPath = parseOutPath(process.argv);
    if (outPath) {
      fs.writeFileSync(
        outPath,
        JSON.stringify(
          {
            serverPid,
            policyPath,
            org: orgPda.toBase58(),
            role: rolePda.toBase58(),
            holder: holder.publicKey.toBase58(),
            signatures: {
              createOrg: createOrgSig,
              createRole: createRoleSig,
              assignRole: assignRoleSig,
              revokeRole: revokeRoleSig,
            },
            ask1: ask1Message,
            ask2: ask2Message,
            ask2RetryUsed,
          },
          null,
          2
        )
      );
    }
  } finally {
    if (child && child.exitCode === null && !child.killed) {
      child.stdin.end();
      try {
        await waitForExit(child, 3000);
      } catch {
        child.kill();
      }
    }
    fs.rmSync(policyPath, { force: true });
  }
}

main().catch((error) => {
  console.error("[error] revoke demo failed:");
  console.error(error);
  process.exit(1);
});
