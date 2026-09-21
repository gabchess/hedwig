import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";

import { SERVER_PATH, assertServerBuilt } from "./e2e-helpers";

const CLIENT_SCRIPT = join(__dirname, "policy-defect-client.js");

interface ProbeCall {
  elapsedMs: number;
  result: {
    structuredContent?: { verdict: string; results: { id: string }[] };
  };
}
interface ProbeOutput {
  ok: boolean;
  error?: string;
  calls?: ProbeCall[];
}

function runProbe(policyPath: string): ProbeOutput {
  const raw = execFileSync(
    process.execPath,
    [CLIENT_SCRIPT, SERVER_PATH, policyPath],
    { encoding: "utf8", timeout: 8000 }
  );
  return JSON.parse(raw);
}

function assertBothCallsAnsweredUnknownQuickly(output: ProbeOutput): void {
  expect(output.ok, output.error).to.equal(true);
  expect(output.calls).to.have.length(2);
  output.calls!.forEach((call) => {
    expect(call.result.structuredContent?.verdict).to.equal("UNKNOWN");
    expect(call.result.structuredContent?.results[0]?.id).to.equal("adapter");
    expect(call.elapsedMs).to.be.lessThan(1000);
  });
}

describe("a policy path that is not a small regular file, driven over real stdio", function () {
  this.timeout(30000);

  before(assertServerBuilt);

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-mcp-policy-defect-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a directory answers UNKNOWN in under a second, twice in a row", () => {
    const dirPath = join(dir, "policy-is-a-dir");
    mkdirSync(dirPath);
    assertBothCallsAnsweredUnknownQuickly(runProbe(dirPath));
  });

  it("a missing path answers UNKNOWN in under a second, twice in a row", () => {
    const missingPath = join(dir, "does-not-exist.json");
    assertBothCallsAnsweredUnknownQuickly(runProbe(missingPath));
  });

  it("an oversized file (over 256 KB) answers UNKNOWN in under a second without reading its content", () => {
    const policyPath = join(dir, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({ permits: true, pad: "x".repeat(300 * 1024) })
    );
    assertBothCallsAnsweredUnknownQuickly(runProbe(policyPath));
  });

  it("a FIFO answers UNKNOWN in under a second instead of hanging", function () {
    const fifoPath = join(dir, "policy.fifo");
    try {
      execFileSync("mkfifo", [fifoPath]);
    } catch {
      this.skip();
    }
    assertBothCallsAnsweredUnknownQuickly(runProbe(fifoPath));
  });
});
