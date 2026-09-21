/**
 * Devnet revoke demo: one Hedwig org, one role, one MCP server process,
 * two "consult" calls either side of a real on-chain revoke_role.
 *
 * Uses a throwaway keypair this script generates and funds itself; it never
 * reads the caller's own Solana wallet. Thin wiring only: every decision
 * with a security or correctness consequence lives in revoke-demo-lib.ts,
 * where it is unit tested. Usage: see app/README.md.
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
import { Connection, Keypair } from "@solana/web3.js";

import {
  assertAsk1,
  assertAsk2,
  assertDevnetGenesisHash,
  assertServerBuilt,
  assertServerProcessAlive,
  airdropAmountLamports,
  buildConnectionOptions,
  buildMachineRecord,
  buildPolicyFile,
  buildServerEnv,
  DEFAULT_KEYPAIR_PATH,
  extractAskSummary,
  formatTranscript,
  isAsk2Valid,
  loadOrGenerateKeypair,
  parseOutPath,
  PAY_REQUEST,
  shouldRequestAirdrop,
  type AskSummary,
} from "./revoke-demo-lib";

const SERVER_PATH = path.join(__dirname, "..", "mcp", "dist", "server.js");
const RESPONSE_TIMEOUT_MS = 15_000;
const RETRY_WAIT_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  // B2: the cheapest possible failure, before any network call.
  assertServerBuilt(SERVER_PATH);

  const rpcUrl = (
    process.env.HEDWIG_DEMO_RPC_URL || "https://api.devnet.solana.com"
  ).trim();
  const connection = new Connection(rpcUrl, buildConnectionOptions());

  const genesisHash = await connection.getGenesisHash();
  assertDevnetGenesisHash(genesisHash);

  const keypairPath = process.env.HEDWIG_DEMO_KEYPAIR || DEFAULT_KEYPAIR_PATH;
  const admin = loadOrGenerateKeypair(keypairPath);

  const balance = await connection.getBalance(admin.publicKey);
  if (shouldRequestAirdrop(balance)) {
    try {
      const airdropSig = await connection.requestAirdrop(
        admin.publicKey,
        airdropAmountLamports()
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

  // B2: the policy is written before any transaction is sent. It needs no
  // chain state: the role PDA is a pure derivation from org + role name,
  // and the holder is generated in memory.
  const policy = buildPolicyFile({
    programId: HEDWIG_PROGRAM_ID.toBase58(),
    role: rolePda.toBase58(),
    holder: holder.publicKey.toBase58(),
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hedwig-demo-"));
  const policyPath = path.join(tmpDir, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });

  let child: ChildProcessWithoutNullStreams | undefined;
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (child && child.exitCode === null && !child.killed) {
      child.kill();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };
  // B3: SIGINT/SIGTERM must not leave the temp policy directory behind.
  const onSignal = (): void => {
    cleanup();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    // The org PDA is derived from the admin key alone, so a reused
    // throwaway admin key can only create it once, ever. A fresh role
    // name each run avoids colliding with a role from an earlier run
    // under the same org.
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

    child = spawn(process.execPath, [SERVER_PATH], {
      env: buildServerEnv(
        process.env,
        policyPath,
        rpcUrl,
        admin.publicKey.toBase58()
      ),
    });
    const serverPid = child.pid;

    await initializeServer(child);

    assertServerProcessAlive(child, serverPid);
    const ask1Message = await callConsult(child);
    const ask1 = assertAsk1(extractAskSummary(ask1Message));

    const revokeRoleSig = await sendRevokeRole(
      provider,
      { role: rolePda, holder: holder.publicKey, admin: admin.publicKey },
      { signers: [] }
    );

    assertServerProcessAlive(child, serverPid);
    let ask2Message = await callConsult(child);
    let ask2Summary = extractAskSummary(ask2Message);
    let ask2FirstAttemptMessage: unknown;
    let ask2FirstAttemptSummary: AskSummary | undefined;
    if (!isAsk2Valid(ask2Summary)) {
      ask2FirstAttemptMessage = ask2Message;
      ask2FirstAttemptSummary = ask2Summary;
      await sleep(RETRY_WAIT_MS);
      assertServerProcessAlive(child, serverPid);
      ask2Message = await callConsult(child);
      ask2Summary = extractAskSummary(ask2Message);
    }
    const ask2: AskSummary = assertAsk2(ask2Summary);

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
      ask2FirstAttempt: ask2FirstAttemptSummary,
    });
    console.log(transcript);

    const outPath = parseOutPath(process.argv);
    if (outPath) {
      const record = buildMachineRecord({
        rpcUrl,
        serverPid: serverPid as number,
        org: orgPda.toBase58(),
        role: rolePda.toBase58(),
        holder: holder.publicKey.toBase58(),
        signatures: {
          createOrg: createOrgSig,
          createRole: createRoleSig,
          assignRole: assignRoleSig,
          revokeRole: revokeRoleSig,
        },
        ask1: { pid: serverPid as number, message: ask1Message },
        ask2: { pid: serverPid as number, message: ask2Message },
        ask2FirstAttempt: ask2FirstAttemptMessage
          ? { pid: serverPid as number, message: ask2FirstAttemptMessage }
          : undefined,
      });
      fs.writeFileSync(outPath, JSON.stringify(record, null, 2));
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
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    cleanup();
  }
}

main().catch((error) => {
  console.error("[error] revoke demo failed:");
  console.error(error);
  process.exit(1);
});
