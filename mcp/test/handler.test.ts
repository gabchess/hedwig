import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";

import { consult } from "@hedwig/consult";
import { handleConsult } from "../src/handler";

const FIXTURES_DIR = join(__dirname, "fixtures");
const VALID_REQUEST = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "request.json"), "utf8")
);
const VALID_POLICY = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "policy.json"), "utf8")
);

describe("handleConsult", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-mcp-handler-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePolicy(content: string): string {
    const path = join(dir, "policy.json");
    writeFileSync(path, content);
    return path;
  }

  it("returns the same verdict consult() returns for a valid request and the fixture policy", () => {
    const policyPath = writePolicy(JSON.stringify(VALID_POLICY));

    const result = handleConsult({ request: VALID_REQUEST }, policyPath);
    const direct = consult(VALID_REQUEST as never, VALID_POLICY as never);

    expect(result).to.deep.equal(direct);
    expect(result.verdict).to.equal("ALLOW_UNDER_POLICY");
  });

  it("returns DENY as a normal result for an over-cap amount", () => {
    const policyPath = writePolicy(JSON.stringify(VALID_POLICY));
    const overCapRequest = {
      action: { ...VALID_REQUEST.action, amount: "1000001" },
    };

    const result = handleConsult({ request: overCapRequest }, policyPath);

    expect(result.verdict).to.equal("DENY");
  });

  it("ignores extra keys alongside request; the caller cannot choose the policy", () => {
    const policyPath = writePolicy(JSON.stringify(VALID_POLICY));

    const withExtras = handleConsult(
      {
        request: VALID_REQUEST,
        policy: {
          permits: true,
          chainId: "eip155:1",
          approvedRecipients: [],
          perActionCaps: { pay: "999999999" },
        },
        policyId: "owner-override",
        policyPath: "/tmp/not-the-real-policy.json",
        facts: { anything: true },
        catalog: { pay: [] },
      },
      policyPath
    );
    const withoutExtras = handleConsult({ request: VALID_REQUEST }, policyPath);

    expect(withExtras).to.deep.equal(withoutExtras);
    expect(withExtras.verdict).to.equal("ALLOW_UNDER_POLICY");
  });

  it("reflects a policy file edit on the very next call, with no restart", () => {
    const policyPath = writePolicy(JSON.stringify(VALID_POLICY));

    const first = handleConsult({ request: VALID_REQUEST }, policyPath);
    expect(first.verdict).to.equal("ALLOW_UNDER_POLICY");

    writePolicy(JSON.stringify({ ...VALID_POLICY, permits: false }));
    const second = handleConsult({ request: VALID_REQUEST }, policyPath);
    expect(second.verdict).to.equal("UNKNOWN");
  });

  describe("a policy requiring a Solana role", () => {
    const REQUIRED_ROLE_POLICY = {
      ...VALID_POLICY,
      role: {
        mode: "required",
        cluster: "mainnet-beta",
        programId: "HwPrgram9RankSeedABCDEFGHHwPrgra",
        role: "HwReNameSeedJKMNPQRSTUVWXHwReNam",
        holder: "HwHderSeedYZabcdefgh9jkHwHderSee",
        maxAgeSeconds: 60,
      },
    };
    const GOOD_FACT = {
      subject: {
        cluster: "mainnet-beta",
        programId: "HwPrgram9RankSeedABCDEFGHHwPrgra",
        role: "HwReNameSeedJKMNPQRSTUVWXHwReNam",
        holder: "HwHderSeedYZabcdefgh9jkHwHderSee",
      },
      valid: true,
      reason: "ok",
      provenance: {
        source: "attacker-supplied",
        slot: 1,
        commitment: "confirmed",
        observedAt: 1,
      },
    };

    it("answers UNKNOWN with ROLE_FACT_MISSING: the adapter never forwards a fact the caller supplied", () => {
      const policyPath = writePolicy(JSON.stringify(REQUIRED_ROLE_POLICY));

      const plain = handleConsult({ request: VALID_REQUEST }, policyPath);
      expect(plain.verdict).to.equal("UNKNOWN");
      expect(
        plain.results.find((r) => r.id === "role-requirement-met")?.code
      ).to.equal("ROLE_FACT_MISSING");

      const withRoleEverywhere = handleConsult(
        {
          request: {
            ...VALID_REQUEST,
            solanaRole: GOOD_FACT,
            facts: {
              now: Math.floor(Date.now() / 1000),
              solanaRole: {
                ...GOOD_FACT,
                provenance: {
                  ...GOOD_FACT.provenance,
                  observedAt: Math.floor(Date.now() / 1000),
                },
              },
            },
          },
          solanaRole: GOOD_FACT,
          facts: { solanaRole: GOOD_FACT },
          _meta: { facts: { solanaRole: GOOD_FACT } },
        },
        policyPath
      );
      expect(withRoleEverywhere.verdict).to.equal("UNKNOWN");
      expect(
        withRoleEverywhere.results.find((r) => r.id === "role-requirement-met")
          ?.code
      ).to.equal("ROLE_FACT_MISSING");
    });
  });

  describe("a broken policy file never yields an MCP error or an ALLOW", () => {
    it("missing file", () => {
      const missingPath = join(dir, "does-not-exist.json");
      const result = handleConsult({ request: VALID_REQUEST }, missingPath);
      expect(result.verdict).to.equal("UNKNOWN");
      expect(result.results).to.have.length(1);
      expect(result.results[0].id).to.equal("adapter");
      expect(result.results[0].status).to.equal("UNVERIFIED");
      // The adapter's own UNKNOWN response carries every new field, and
      // never a code any consult() Condition would itself declare.
      expect(result.proceed).to.equal(false);
      expect(result.support).to.equal(0);
      expect(result.band).to.equal("red");
      expect(result.results[0].code).to.equal("ADAPTER_POLICY_UNREADABLE");
      expect(result.results[0].evidence).to.match(/^cannot confirm/);
      expect(result.results[0].evidenceClass).to.equal("not-verifiable");
      expect(result.results[0].reference).to.be.a("string").that.is.not.empty;
    });

    it("unreadable file (a directory in its place)", () => {
      const dirPath = join(dir, "policy-is-a-dir.json");
      mkdirSync(dirPath);
      const result = handleConsult({ request: VALID_REQUEST }, dirPath);
      expect(result.verdict).to.equal("UNKNOWN");
      expect(result.results[0].id).to.equal("adapter");
    });

    it("an oversized file (over 256 KB) is refused without being read", () => {
      const policyPath = writePolicy("x".repeat(300 * 1024));
      const result = handleConsult({ request: VALID_REQUEST }, policyPath);
      expect(result.verdict).to.equal("UNKNOWN");
      expect(result.results[0].id).to.equal("adapter");
    });

    it("empty file", () => {
      const policyPath = writePolicy("");
      const result = handleConsult({ request: VALID_REQUEST }, policyPath);
      expect(result.verdict).to.equal("UNKNOWN");
      expect(result.results[0].id).to.equal("adapter");
    });

    it("not JSON", () => {
      const policyPath = writePolicy("not json at all");
      const result = handleConsult({ request: VALID_REQUEST }, policyPath);
      expect(result.verdict).to.equal("UNKNOWN");
      expect(result.results[0].id).to.equal("adapter");
    });

    it("a JSON array (valid JSON, wrong shape: consult's own UNKNOWN, never ALLOW)", () => {
      const policyPath = writePolicy("[]");
      const result = handleConsult({ request: VALID_REQUEST }, policyPath);
      expect(result.verdict).to.equal("UNKNOWN");
    });

    it("null (valid JSON, wrong shape: consult's own UNKNOWN, never ALLOW)", () => {
      const policyPath = writePolicy("null");
      const result = handleConsult({ request: VALID_REQUEST }, policyPath);
      expect(result.verdict).to.equal("UNKNOWN");
    });
  });

  describe("malformed request values never crash the handler", () => {
    const malformedRequests: Array<[string, unknown]> = [
      ["missing", undefined],
      ["null", null],
      ["a string", "not-a-request"],
      ["an array", []],
      ["a number", 42],
      ["deeply nested", { a: { b: { c: { d: { e: { action: null } } } } } }],
      [
        "a prototype-key action type",
        { action: { type: "__proto__", chainId: "eip155:1" } },
      ],
    ];

    malformedRequests.forEach(([label, request]) => {
      it(`${label}`, () => {
        const policyPath = writePolicy(JSON.stringify(VALID_POLICY));
        const args = request === undefined ? {} : { request };
        const result = handleConsult(args, policyPath);
        expect(result.verdict).to.equal("UNKNOWN");
      });
    });
  });

  it("answers UNKNOWN quickly for arguments over 64 KB", () => {
    const policyPath = writePolicy(JSON.stringify(VALID_POLICY));
    const oversizedRequest = {
      action: { ...VALID_REQUEST.action, memo: "x".repeat(70 * 1024) },
    };

    const startedAt = Date.now();
    const result = handleConsult({ request: oversizedRequest }, policyPath);
    const elapsedMs = Date.now() - startedAt;

    expect(result.verdict).to.equal("UNKNOWN");
    expect(result.results[0].id).to.equal("adapter");
    expect(result.results[0].code).to.equal("ADAPTER_INPUT_TOO_LARGE");
    expect(elapsedMs).to.be.lessThan(200);
  });

  it("counts a multi-byte argument by bytes, not by string.length", () => {
    // "€" (Euro sign) is one UTF-16 code unit but three UTF-8 bytes.
    // At this count the serialised string.length (65233) is under the 64 KB
    // (65536) cap, so a length-based cap would let it through, while its
    // real size on the wire (195233 bytes) is well over.
    const policyPath = writePolicy(JSON.stringify(VALID_POLICY));
    const oversizedRequest = {
      action: { ...VALID_REQUEST.action, memo: "€".repeat(65000) },
    };
    const serializedLength = JSON.stringify({
      request: oversizedRequest,
    }).length;
    expect(serializedLength).to.be.lessThan(64 * 1024);

    const result = handleConsult({ request: oversizedRequest }, policyPath);

    expect(result.verdict).to.equal("UNKNOWN");
    expect(result.results[0].id).to.equal("adapter");
  });

  it("is byte-for-byte the same as calling consult() directly for an ALLOW", () => {
    const policyPath = writePolicy(JSON.stringify(VALID_POLICY));

    const result = handleConsult({ request: VALID_REQUEST }, policyPath);
    const direct = consult(VALID_REQUEST as never, VALID_POLICY as never);

    expect(result.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(JSON.stringify(result)).to.equal(JSON.stringify(direct));
  });

  it("is byte-for-byte the same as calling consult() directly for a DENY", () => {
    const policyPath = writePolicy(JSON.stringify(VALID_POLICY));
    const overCapRequest = {
      action: { ...VALID_REQUEST.action, amount: "1000001" },
    };

    const result = handleConsult({ request: overCapRequest }, policyPath);
    const direct = consult(overCapRequest as never, VALID_POLICY as never);

    expect(result.verdict).to.equal("DENY");
    expect(JSON.stringify(result)).to.equal(JSON.stringify(direct));
  });

  it("is byte-for-byte the same as calling consult() directly for an UNKNOWN", () => {
    const policyPath = writePolicy(JSON.stringify(VALID_POLICY));
    const malformedRequest = { action: null };

    const result = handleConsult({ request: malformedRequest }, policyPath);
    const direct = consult(malformedRequest as never, VALID_POLICY as never);

    expect(result.verdict).to.equal("UNKNOWN");
    expect(JSON.stringify(result)).to.equal(JSON.stringify(direct));
  });
});
