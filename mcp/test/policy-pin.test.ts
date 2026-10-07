import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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

// require, not import: a namespace import is a copy under esModuleInterop, and
// the tests below patch the functions the policy reader really calls.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realFs = require("node:fs");
const MAX_POLICY_BYTES = 256 * 1024;

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
  transaction: {
    ...VALID_REQUEST.transaction,
    data:
      "0xa9059cbb" +
      ATTACKER.slice(2).padStart(64, "0") +
      1_000_000n.toString(16).padStart(64, "0"),
  },
};
const ATTACKER_ALLOWED_POLICY = {
  ...VALID_POLICY,
  approvedRecipients: [...VALID_POLICY.approvedRecipients, ATTACKER],
};

describe("the policy file is pinned when the server starts", () => {
  let dir: string;
  let policyPath: string;
  const restores: (() => void)[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-mcp-policy-pin-"));
    policyPath = join(dir, "policy.json");
  });

  afterEach(() => {
    while (restores.length > 0) {
      restores.pop()!();
    }
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

  // Runs `action` once, right after the first call to any of the named fs
  // functions returns. That is the window between one look at the policy file
  // and the next, which the reader must not leave open.
  function afterFirstFsCall(names: string[], action: () => void): void {
    let fired = false;
    for (const name of names) {
      const original = realFs[name];
      restores.push(() => {
        realFs[name] = original;
      });
      realFs[name] = function (this: unknown, ...args: unknown[]) {
        const result = original.apply(this, args);
        if (!fired) {
          fired = true;
          action();
        }
        return result;
      };
    }
  }

  // A new inode under the same path, like a swap by rename: a descriptor
  // opened earlier keeps the old file.
  function replaceByRename(contents: string): void {
    const staged = join(dir, "staged.json");
    writeFileSync(staged, contents);
    renameSync(staged, policyPath);
  }

  it("the reply an agent sees never tells it to restart the server", async () => {
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));
    const pin = pinPolicyFile(policyPath);
    writeFileSync(policyPath, JSON.stringify(ATTACKER_ALLOWED_POLICY));
    const changed = await ask(ATTACKER_REQUEST, pin);

    const missingAtStart = await ask(
      ATTACKER_REQUEST,
      pinPolicyFile(join(dir, "never-there.json"))
    );

    for (const result of [changed, missingAtStart]) {
      expect(JSON.stringify(result)).to.not.match(/restart/i);
    }
    expect(changed.results[0].evidence).to.equal(
      "cannot confirm: policy file changed since the server started"
    );
  });

  it("a swap after the reader first looks at the file does not change what it reads: the size and type check and the read are one file", async () => {
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));
    const pin = pinPolicyFile(policyPath);

    afterFirstFsCall(["statSync", "openSync", "readFileSync"], () =>
      replaceByRename(
        JSON.stringify(VALID_POLICY) + " ".repeat(MAX_POLICY_BYTES)
      )
    );
    const result = await ask(VALID_REQUEST, pin);

    expect(result.verdict).to.equal("ALLOW_UNDER_POLICY");
  });

  it("a file that grows past the cap after it was measured is refused, not read in full", async () => {
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));
    const pin = pinPolicyFile(policyPath);

    afterFirstFsCall(["fstatSync"], () =>
      appendFileSync(policyPath, " ".repeat(MAX_POLICY_BYTES * 2))
    );
    const result = await ask(VALID_REQUEST, pin);

    expect(result.verdict).to.equal("UNKNOWN");
    expect(result.results[0].code).to.equal("ADAPTER_POLICY_UNREADABLE");
  });

  it("the bytes that are hashed are the bytes that are parsed: a file swapped during the read cannot slip other content past the pin", async () => {
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));
    const pin = pinPolicyFile(policyPath);

    afterFirstFsCall(["statSync", "openSync", "readFileSync"], () =>
      replaceByRename(JSON.stringify(ATTACKER_ALLOWED_POLICY))
    );
    const result = await ask(ATTACKER_REQUEST, pin);

    expect(result.verdict).to.equal("DENY");
  });

  it("a FIFO put in the policy file's place answers unreadable and does not block", () => {
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));
    const pin = pinPolicyFile(policyPath);
    unlinkSync(policyPath);
    execFileSync("mkfifo", [policyPath]);

    // A blocked read cannot be timed out from inside this process, so it runs
    // in a child that the timeout can kill.
    const script = `
      const { handleConsult } = require(${JSON.stringify(
        join(__dirname, "..", "src", "handler")
      )});
      handleConsult({ request: {} }, ${JSON.stringify(
        policyPath
      )}, ${JSON.stringify(
      pin
    )}).then((r) => process.stdout.write(r.results[0].code));
    `;
    const output = execFileSync(
      process.execPath,
      ["-r", "ts-node/register/transpile-only", "-e", script],
      {
        encoding: "utf8",
        timeout: 20000,
        env: {
          ...process.env,
          TS_NODE_PROJECT: join(__dirname, "..", "tsconfig.test.json"),
        },
      }
    );

    expect(output).to.equal("ADAPTER_POLICY_UNREADABLE");
  });
});
