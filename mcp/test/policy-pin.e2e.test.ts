import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";

import { SERVER_PATH, VALID_POLICY, assertServerBuilt } from "./e2e-helpers";

const CLIENT_SCRIPT = join(__dirname, "policy-pin-client.js");

interface Structured {
  verdict: string;
  results: { id: string; code?: string }[];
}
interface Probe {
  ok: boolean;
  error?: string;
  before: Structured;
  after: Structured;
  stderr: string;
}

function probe(
  policyPath: string,
  mode: string,
  replacement = "",
  when = "betweenCalls"
): Probe {
  const raw = execFileSync(
    process.execPath,
    [CLIENT_SCRIPT, SERVER_PATH, policyPath, mode, replacement, when],
    { encoding: "utf8", timeout: 15000 }
  );
  const output = JSON.parse(raw);
  expect(output.ok, output.error).to.equal(true);
  return output;
}

describe("the policy file is pinned at server start, driven over real stdio", function () {
  this.timeout(30000);

  before(assertServerBuilt);

  let dir: string;
  let policyPath: string;
  let changedPolicyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-mcp-policy-pin-e2e-"));
    policyPath = join(dir, "policy.json");
    changedPolicyPath = join(dir, "changed.json");
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));
    writeFileSync(
      changedPolicyPath,
      JSON.stringify({ ...VALID_POLICY, perActionCaps: { pay: "999999999" } })
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("an unchanged file answers ALLOW_UNDER_POLICY twice and logs no change", () => {
    const output = probe(policyPath, "none");

    expect(output.before.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(output.after.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(output.stderr).to.not.include("changed since");
  });

  it("an edit after the first call answers UNKNOWN with ADAPTER_POLICY_CHANGED and logs the change by env var name", () => {
    const output = probe(policyPath, "edit", changedPolicyPath);

    expect(output.before.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(output.after.verdict).to.equal("UNKNOWN");
    expect(output.after.results[0].id).to.equal("adapter");
    expect(output.after.results[0].code).to.equal("ADAPTER_POLICY_CHANGED");
    expect(output.stderr).to.include("HEDWIG_POLICY_FILE");
    expect(output.stderr).to.include("changed since");
    expect(output.stderr).to.not.include(policyPath);
    expect(output.stderr).to.not.include("999999999");
  });

  it("an edit after the server is up but before the first call answers UNKNOWN: the pin is taken at start, not at the first call", () => {
    const output = probe(policyPath, "edit", changedPolicyPath, "beforeFirst");

    expect(output.before.verdict).to.equal("UNKNOWN");
    expect(output.before.results[0].code).to.equal("ADAPTER_POLICY_CHANGED");
    expect(output.after.verdict).to.equal("UNKNOWN");
  });

  it("the reply the agent receives does not tell it to restart the server", () => {
    const output = probe(policyPath, "edit", changedPolicyPath);

    expect(JSON.stringify(output.after)).to.not.match(/restart/i);
  });

  it("a deletion after the first call answers UNKNOWN with ADAPTER_POLICY_UNREADABLE", () => {
    const output = probe(policyPath, "delete");

    expect(output.after.verdict).to.equal("UNKNOWN");
    expect(output.after.results[0].code).to.equal("ADAPTER_POLICY_UNREADABLE");
  });

  it("a symlink swap after the first call answers UNKNOWN with ADAPTER_POLICY_CHANGED", () => {
    const output = probe(policyPath, "symlink", changedPolicyPath);

    expect(output.after.verdict).to.equal("UNKNOWN");
    expect(output.after.results[0].code).to.equal("ADAPTER_POLICY_CHANGED");
  });

  it("a restart after an edit accepts the new policy from the first call", () => {
    probe(policyPath, "edit", changedPolicyPath);

    const restarted = probe(policyPath, "none");

    expect(restarted.before.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(restarted.after.verdict).to.equal("ALLOW_UNDER_POLICY");
  });
});
