import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";

import { SERVER_PATH, VALID_POLICY, assertServerBuilt } from "./e2e-helpers";

// Short on purpose: a JSON parse error quotes only the first ten bytes of a
// bad line, so a longer marker would never appear whole.
const CANARY = "CANARY9";

// Lines no client library would send, written straight onto the server's
// stdin: each is one message a caller can produce with a single write.
const GARBAGE_LINES = [
  "",
  "\r",
  // The canary leads the line: a JSON parse error quotes the first bytes.
  `${CANARY} is not json`,
  `"${CANARY}"`,
  "[]",
  "{}",
  '{"jsonrpc":"2.0","id":null,"method":"tools/call"}',
  '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":null}',
  `{"jsonrpc":"2.0","id":8,"method":"tools/call","params":"${CANARY}"}`,
];

interface Outcome {
  exitCode: number | null;
  stderr: string;
  answer: { result?: { structuredContent?: { verdict?: string } } } | undefined;
}

function driveServer(policyPath: string, request: unknown): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, HEDWIG_POLICY_FILE: policyPath },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      const exitCode = child.exitCode;
      const answer = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
        .find((message) => message.id === 2);
      child.kill();
      resolve({ exitCode, stderr, answer });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes('"id":2')) finish();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", finish);
    setTimeout(finish, 5000);

    const send = (line: string): void => {
      child.stdin.write(`${line}\n`);
    };
    GARBAGE_LINES.forEach(send);
    send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "garbage-lines-test", version: "0.0.0" },
        },
      })
    );
    send(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    );
    send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "consult", arguments: { request } },
      })
    );
  });
}

describe("malformed lines written straight onto stdin", function () {
  this.timeout(15000);

  before(assertServerBuilt);

  let dir: string;
  let policyPath: string;
  const request = JSON.parse(
    readFileSync(join(__dirname, "fixtures", "request.json"), "utf8")
  );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-mcp-garbage-"));
    policyPath = join(dir, "policy.json");
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("do not stop the server: the next valid call is still answered", async () => {
    const outcome = await driveServer(policyPath, request);

    expect(outcome.exitCode, "server exited").to.equal(null);
    expect(outcome.answer?.result?.structuredContent?.verdict).to.be.a(
      "string"
    );
  });

  it("a message over the transport limit exits non-zero with one fixed line", async () => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, HEDWIG_POLICY_FILE: policyPath },
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.stdin.on("error", () => undefined);
      child.stdin.write(`${CANARY}${"x".repeat(300 * 1024)}\n`);
    });

    expect(exitCode).to.equal(1);
    expect(stderr.trim()).to.equal(
      "hedwig-mcp: input exceeded the transport limit"
    );
  });

  it("never reach stderr", async () => {
    const outcome = await driveServer(policyPath, request);

    expect(outcome.stderr).to.not.include(CANARY);
    expect(outcome.stderr).to.not.include("\r");
    // Every line the server logs is one of its own fixed lines: no parser
    // message, no validation dump.
    outcome.stderr
      .split("\n")
      .filter((line) => line.length > 0)
      .forEach((line) => {
        expect(line).to.match(/^(consult: verdict=|hedwig-mcp: )/);
      });
  });
});
