import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import { consult } from "../src";

interface GoldenCase {
  id: string;
  description: string;
  label_source: string;
  reviewed: boolean;
  policySha256: string;
  input: { request: unknown; policy: unknown; facts?: unknown };
  expected: {
    verdict: string;
    proceed: boolean;
    band: string;
    failIds: string[];
    unverifiedIds: string[];
  };
}

interface GoldenFile {
  schemaVersion: number;
  policyVersion: string;
  notice: string;
  floorIds: Record<string, string[]>;
  cases: GoldenCase[];
}

const GOLDEN: GoldenFile = JSON.parse(
  readFileSync(join(__dirname, "golden", "golden-cases.json"), "utf8")
);

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

function policyHash(policy: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortKeys(policy)))
    .digest("hex");
}

function idsWithStatus(
  results: readonly { id: string; status: string }[],
  status: string
): string[] {
  return results
    .filter((row) => row.status === status)
    .map((row) => row.id)
    .sort();
}

describe("golden cases", () => {
  it("pins the policy version and marks every label unreviewed", () => {
    expect(GOLDEN.schemaVersion).to.equal(1);
    expect(GOLDEN.policyVersion).to.equal("golden-policy-1");
    expect(GOLDEN.notice).to.match(/domain reviewer must confirm/);
    expect(GOLDEN.cases.length).to.be.at.least(30);
    expect(new Set(GOLDEN.cases.map((c) => c.id)).size).to.equal(
      GOLDEN.cases.length
    );
    GOLDEN.cases.forEach((c) => {
      expect(c.reviewed, c.id).to.equal(false);
      expect(c.label_source, c.id).to.be.a("string").and.not.equal("");
      expect(c.description, c.id).to.be.a("string").and.not.equal("");
    });
  });

  it("covers allow, deny and unknown verdicts and every band", () => {
    const verdicts = new Set(GOLDEN.cases.map((c) => c.expected.verdict));
    const bands = new Set(GOLDEN.cases.map((c) => c.expected.band));
    expect([...verdicts].sort()).to.deep.equal([
      "ALLOW_UNDER_POLICY",
      "DENY",
      "UNKNOWN",
    ]);
    expect([...bands].sort()).to.deep.equal(["amber", "green", "red"]);
  });

  GOLDEN.cases.forEach((c) => {
    it(c.id, () => {
      expect(policyHash(c.input.policy), "policySha256").to.equal(
        c.policySha256
      );

      const response = consult(
        c.input.request as never,
        c.input.policy as never,
        c.input.facts as never
      );
      const actionType = (c.input.request as { action: { type: string } })
        .action.type;

      expect(response.verdict, "verdict").to.equal(c.expected.verdict);
      expect(response.proceed, "proceed").to.equal(c.expected.proceed);
      expect(response.band, "band").to.equal(c.expected.band);
      expect(idsWithStatus(response.results, "FAIL"), "FAIL ids").to.deep.equal(
        c.expected.failIds
      );
      expect(
        idsWithStatus(response.results, "UNVERIFIED"),
        "UNVERIFIED ids"
      ).to.deep.equal(c.expected.unverifiedIds);
      if (GOLDEN.floorIds[actionType]) {
        expect([...response.floorIds].sort(), "floorIds").to.deep.equal(
          [...GOLDEN.floorIds[actionType]].sort()
        );
      }
    });
  });
});
