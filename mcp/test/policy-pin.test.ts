import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";

import { handleConsult } from "../src/handler";
import { pinPolicyFile } from "../src/policy";

const FIXTURES_DIR = join(__dirname, "fixtures");
const VALID_REQUEST = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "request.json"), "utf8")
);
const VALID_POLICY = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "policy.json"), "utf8")
);

const ATTACKER = "0x00000000000000000000000000000000badbad01";
const ATTACKER_REQUEST = {
  action: { ...VALID_REQUEST.action, recipient: ATTACKER },
};
const ATTACKER_ALLOWED_POLICY = {
  ...VALID_POLICY,
  approvedRecipients: [...VALID_POLICY.approvedRecipients, ATTACKER],
};

describe("the policy file is pinned when the server starts", () => {
  let dir: string;
  let policyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-mcp-policy-pin-"));
    policyPath = join(dir, "policy.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ask(request: unknown, pin: ReturnType<typeof pinPolicyFile>) {
    return handleConsult({ request }, policyPath, pin);
  }

  it("an unchanged file keeps answering normally, call after call", async () => {
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));
    const pin = pinPolicyFile(policyPath);

    const first = await ask(VALID_REQUEST, pin);
    const second = await ask(VALID_REQUEST, pin);

    expect(first.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(second).to.deep.equal(first);
  });

  it("a file edited mid-session answers UNKNOWN with ADAPTER_POLICY_CHANGED: an edit that adds a payee does not get that payee approved", async () => {
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));
    const pin = pinPolicyFile(policyPath);
    expect((await ask(ATTACKER_REQUEST, pin)).verdict).to.equal("DENY");

    writeFileSync(policyPath, JSON.stringify(ATTACKER_ALLOWED_POLICY));
    const result = await ask(ATTACKER_REQUEST, pin);

    expect(result.verdict).to.equal("UNKNOWN");
    expect(result.proceed).to.equal(false);
    expect(result.results).to.have.length(1);
    expect(result.results[0].id).to.equal("adapter");
    expect(result.results[0].code).to.equal("ADAPTER_POLICY_CHANGED");
    expect(result.results[0].evidence).to.match(/^cannot confirm/);
  });

  it("a one-byte whitespace edit counts as a change: the hash covers the exact bytes", async () => {
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));
    const pin = pinPolicyFile(policyPath);

    writeFileSync(policyPath, JSON.stringify(VALID_POLICY) + "\n");
    const result = await ask(VALID_REQUEST, pin);

    expect(result.verdict).to.equal("UNKNOWN");
    expect(result.results[0].code).to.equal("ADAPTER_POLICY_CHANGED");
  });

  it("a file restored to its pinned bytes answers normally again", async () => {
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));
    const pin = pinPolicyFile(policyPath);

    writeFileSync(policyPath, JSON.stringify(ATTACKER_ALLOWED_POLICY));
    expect((await ask(VALID_REQUEST, pin)).verdict).to.equal("UNKNOWN");

    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));
    expect((await ask(VALID_REQUEST, pin)).verdict).to.equal(
      "ALLOW_UNDER_POLICY"
    );
  });

  it("a file deleted mid-session answers UNKNOWN through the unreadable-policy code", async () => {
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));
    const pin = pinPolicyFile(policyPath);

    unlinkSync(policyPath);
    const result = await ask(VALID_REQUEST, pin);

    expect(result.verdict).to.equal("UNKNOWN");
    expect(result.results[0].id).to.equal("adapter");
    expect(result.results[0].code).to.equal("ADAPTER_POLICY_UNREADABLE");
  });

  it("a file swapped for a symlink to different content answers UNKNOWN with ADAPTER_POLICY_CHANGED", async () => {
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));
    const pin = pinPolicyFile(policyPath);

    const elsewhere = join(dir, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify(ATTACKER_ALLOWED_POLICY));
    unlinkSync(policyPath);
    symlinkSync(elsewhere, policyPath);
    const result = await ask(ATTACKER_REQUEST, pin);

    expect(result.verdict).to.equal("UNKNOWN");
    expect(result.results[0].code).to.equal("ADAPTER_POLICY_CHANGED");
  });

  it("a restart after an edit accepts the new policy", async () => {
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));
    const firstRun = pinPolicyFile(policyPath);

    writeFileSync(policyPath, JSON.stringify(ATTACKER_ALLOWED_POLICY));
    expect((await ask(ATTACKER_REQUEST, firstRun)).verdict).to.equal("UNKNOWN");

    const secondRun = pinPolicyFile(policyPath);
    expect((await ask(ATTACKER_REQUEST, secondRun)).verdict).to.equal(
      "ALLOW_UNDER_POLICY"
    );
  });

  it("a file that was unreadable at start stays unreadable: a file created later is not picked up without a restart", async () => {
    const pin = pinPolicyFile(policyPath);

    writeFileSync(policyPath, JSON.stringify(ATTACKER_ALLOWED_POLICY));
    const result = await ask(ATTACKER_REQUEST, pin);

    expect(result.verdict).to.equal("UNKNOWN");
    expect(result.results[0].code).to.equal("ADAPTER_POLICY_UNREADABLE");
  });
});
