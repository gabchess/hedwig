import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";

import { SERVER_PATH, assertServerBuilt, VALID_POLICY } from "./e2e-helpers";

const CLIENT_SCRIPT = join(__dirname, "e2e-client.js");

describe("the built server, driven over real stdio", function () {
  this.timeout(15000);

  before(assertServerBuilt);

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-mcp-e2e-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists exactly one tool, named consult, with a one-property input schema", () => {
    const policyPath = join(dir, "policy.json");
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));

    const raw = execFileSync(
      process.execPath,
      [CLIENT_SCRIPT, SERVER_PATH, policyPath],
      { encoding: "utf8" }
    );
    const output = JSON.parse(raw);

    expect(output.tools).to.have.length(1);
    expect(output.tools[0].name).to.equal("consult");
    expect(Object.keys(output.tools[0].inputSchema.properties)).to.deep.equal([
      "request",
    ]);
  });

  it("ignores extra keys, answers over-cap arguments with UNKNOWN and an over-cap amount with DENY, never logs the request or policy content", () => {
    const policyPath = join(dir, "policy.json");
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));

    const raw = execFileSync(
      process.execPath,
      [CLIENT_SCRIPT, SERVER_PATH, policyPath],
      { encoding: "utf8" }
    );
    const output = JSON.parse(raw);

    expect(output.validCall.isError).to.equal(false);
    expect(output.validCall.structuredContent.verdict).to.equal(
      "ALLOW_UNDER_POLICY"
    );
    expect(JSON.parse(output.validCall.content[0].text)).to.deep.equal(
      output.validCall.structuredContent
    );

    expect(output.oversizedCall.isError).to.equal(false);
    expect(output.oversizedCall.structuredContent.verdict).to.equal("UNKNOWN");
    expect(output.oversizedCall.structuredContent.results[0].id).to.equal(
      "adapter"
    );
    expect(JSON.parse(output.oversizedCall.content[0].text)).to.deep.equal(
      output.oversizedCall.structuredContent
    );

    expect(output.denyCall.isError).to.equal(false);
    expect(output.denyCall.structuredContent.verdict).to.equal("DENY");
    expect(JSON.parse(output.denyCall.content[0].text)).to.deep.equal(
      output.denyCall.structuredContent
    );

    expect(output.stderr).to.not.include("CANARY-REQUEST-MEMO");
    expect(output.stderr).to.not.include("CANARY-POLICY-RECIPIENT");
    expect(output.stderr).to.not.include(policyPath);
    expect(output.stderr).to.not.include("recipient matches an approved");
  });

  it("refuses to start, exiting non-zero with a message on stderr, when the policy variable is unset", () => {
    const env = { ...process.env };
    delete env.HEDWIG_POLICY_FILE;

    const result = spawnSync(process.execPath, [SERVER_PATH], {
      encoding: "utf8",
      env,
      timeout: 5000,
    });

    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.include("HEDWIG_POLICY_FILE");
  });

  it("refuses to start when the policy variable is only whitespace", () => {
    const env = { ...process.env, HEDWIG_POLICY_FILE: "   " };

    const result = spawnSync(process.execPath, [SERVER_PATH], {
      encoding: "utf8",
      env,
      timeout: 5000,
    });

    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.include("HEDWIG_POLICY_FILE");
  });
});
