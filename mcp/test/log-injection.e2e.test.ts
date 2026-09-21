import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";

import { SERVER_PATH, assertServerBuilt, VALID_POLICY } from "./e2e-helpers";

const CLIENT_SCRIPT = join(__dirname, "log-injection-client.js");

describe("caller-chosen condition ids on stderr, driven over real stdio", function () {
  this.timeout(15000);

  before(assertServerBuilt);

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-mcp-log-injection-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("cannot forge a second log line or write raw escape bytes into stderr", () => {
    const policyPath = join(dir, "policy.json");
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));

    const raw = execFileSync(
      process.execPath,
      [CLIENT_SCRIPT, SERVER_PATH, policyPath],
      { encoding: "utf8" }
    );
    const output = JSON.parse(raw);

    // The call itself is unaffected: a real DENY, answered normally.
    expect(output.denyCall.isError).to.equal(false);
    expect(output.denyCall.structuredContent.verdict).to.equal("DENY");

    const lines = output.stderr.split("\n").filter(Boolean);
    // Every logged line still names only the verdict, proceed, band, and
    // floor ids: the hostile ids never produced a stderr line of their own,
    // forged or otherwise.
    lines.forEach((line: string) => {
      expect(line).to.match(
        /^consult: verdict=\w+ proceed=\w+ band=\w+ results=/
      );
    });
    expect(output.stderr).to.not.include(
      "verdict=ALLOW_UNDER_POLICY proceed=true band=green results=all:PASS"
    );
    expect(output.stderr).to.not.include("\u001b");
    expect(output.stderr).to.not.include("secret");
  });
});
