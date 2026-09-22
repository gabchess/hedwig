import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "chai";

const execFileAsync = promisify(execFile);

import { SERVER_PATH, assertServerBuilt } from "./e2e-helpers";

const CLIENT_SCRIPT = join(__dirname, "solana-role-e2e-client.js");

const GOLDEN = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures", "solana-role", "check-role-golden.json"),
    "utf8"
  )
);

const REQUIRED_ROLE_POLICY = {
  permits: true,
  chainId: "eip155:1",
  approvedRecipients: ["0x00000000000000000000000000000000a11ce001"],
  perActionCaps: { pay: "1000000" },
  role: {
    mode: "required",
    cluster: "devnet",
    programId: GOLDEN.programId,
    role: GOLDEN.role,
    holder: GOLDEN.holder,
    maxAgeSeconds: 60,
  },
  authorizationWindow: { mode: "not-required" },
};

function rpcResult(err: unknown, logs: string[]): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { context: { slot: 12345 }, value: { err, logs } },
  });
}

const OK_BODY = rpcResult(null, [
  `Program ${GOLDEN.programId} invoke [1]`,
  `Program ${GOLDEN.programId} success`,
]);
const REVOKED_BODY = rpcResult({ InstructionError: [0, { Custom: 3012 }] }, [
  `Program ${GOLDEN.programId} invoke [1]`,
  "Program log: AnchorError, Custom(3012)",
]);

function startLocalRpc(
  body: string
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// Writes headers and one small chunk, then never calls res.end(): the
// deadline must cover this or the tool call hangs forever.
function startStallingRpc(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      // Never call res.end(): the body never completes.
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe("the Solana role Reader, driven over real stdio against a local RPC", function () {
  this.timeout(15000);

  before(assertServerBuilt);

  let dir: string;
  let policyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-mcp-solana-role-e2e-"));
    policyPath = join(dir, "policy.json");
    writeFileSync(policyPath, JSON.stringify(REQUIRED_ROLE_POLICY));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reaches ALLOW_UNDER_POLICY when the local RPC reports the role held", async () => {
    const rpc = await startLocalRpc(OK_BODY);
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        CLIENT_SCRIPT,
        SERVER_PATH,
        policyPath,
        rpc.url,
        GOLDEN.feePayer,
      ]);
      const output = JSON.parse(stdout);
      expect(output.structuredContent.verdict).to.equal("ALLOW_UNDER_POLICY");
    } finally {
      await rpc.close();
    }
  });

  it("reaches DENY when the local RPC reports the member missing (revoked)", async () => {
    const rpc = await startLocalRpc(REVOKED_BODY);
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        CLIENT_SCRIPT,
        SERVER_PATH,
        policyPath,
        rpc.url,
        GOLDEN.feePayer,
      ]);
      const output = JSON.parse(stdout);
      expect(output.structuredContent.verdict).to.equal("DENY");
      const row = output.structuredContent.results.find(
        (r: { id: string }) => r.id === "role-requirement-met"
      );
      expect(row?.code).to.equal("ROLE_MEMBER_MISSING");
    } finally {
      await rpc.close();
    }
  });

  it("headers then a stall: answers UNKNOWN within about a second, and the process exits when stdin closes (B1)", async () => {
    const rpc = await startStallingRpc();
    try {
      const startedAt = Date.now();
      const { stdout } = await execFileAsync(process.execPath, [
        CLIENT_SCRIPT,
        SERVER_PATH,
        policyPath,
        rpc.url,
        GOLDEN.feePayer,
      ]);
      const elapsedMs = Date.now() - startedAt;
      const output = JSON.parse(stdout);

      expect(output.structuredContent.verdict).to.equal("UNKNOWN");
      expect(elapsedMs).to.be.lessThan(3000);
      expect(output.serverExited).to.equal(true);
    } finally {
      await rpc.close();
    }
  }).timeout(10000);
});
