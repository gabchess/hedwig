import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import { consult } from "../src";

interface LabelSource {
  url: string;
  kind: string;
  quote?: string;
  line_ref?: string;
  retrieved: string;
}

interface ChainEvidence {
  chainId: string;
  rpc: string;
  method: string;
  call: string;
  block: number;
  result: string;
}

interface Review {
  by: string;
  date: string;
  method: string;
}

interface GoldenCase {
  id: string;
  description: string;
  label_source: string | LabelSource;
  chain_evidence?: ChainEvidence[];
  reviewed: boolean;
  review?: Review;
  expected_origin?: string;
  known_gap?: { desired: string; reason: string };
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
  labelCutoff: string;
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

const SOURCE_KINDS = ["incident", "onchain", "paper", "repo"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function withoutScheme(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

// Every URL the catalog source names is a list the catalog's own tables
// came from, so a label taken from it would only check the catalog against
// itself.
const CATALOG_SOURCE_URLS = [
  ...new Set(
    (
      readFileSync(join(__dirname, "..", "src", "catalog.ts"), "utf8").match(
        /https?:\/\/[^\s"'`)]+/g
      ) ?? []
    ).map((url) => withoutScheme(url.replace(/[.,;]+$/, "")))
  ),
];

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
  it("pins the policy version and the label cutoff", () => {
    expect(GOLDEN.schemaVersion).to.equal(1);
    expect(GOLDEN.policyVersion).to.equal("golden-policy-1");
    expect(GOLDEN.notice).to.match(
      /confirmed by their cited public source plus an independent verifier model/
    );
    expect(GOLDEN.notice).to.match(/H-0001/);
    expect(GOLDEN.notice).to.match(
      /Every expected block is consult\(\) output, so by itself it only pins current behavior and is not ground truth/
    );
    expect(GOLDEN.notice).to.match(
      /independently agreed the expected verdict, band and check ids/
    );
    expect(GOLDEN.labelCutoff).to.match(ISO_DATE);
    expect(GOLDEN.cases.length).to.be.at.least(30);
    expect(new Set(GOLDEN.cases.map((c) => c.id)).size).to.equal(
      GOLDEN.cases.length
    );
  });

  it("allows reviewed true only on a case with a cited public source", () => {
    GOLDEN.cases.forEach((c) => {
      expect(c.description, c.id).to.be.a("string").and.not.equal("");
      expect(c.reviewed, c.id).to.be.a("boolean");
      if (typeof c.label_source === "string") {
        expect(c.label_source, c.id).to.not.equal("");
        expect(c.reviewed, `${c.id} has no public source`).to.equal(false);
      } else {
        expect(c.label_source, c.id).to.be.an("object");
      }
    });
  });

  it("records who confirmed each reviewed case, when and how", () => {
    GOLDEN.cases.forEach((c) => {
      if (!c.reviewed) {
        expect(c.review, `${c.id} is not reviewed`).to.equal(undefined);
        expect(c.expected_origin, `${c.id} is not reviewed`).to.equal(undefined);
        return;
      }
      const review = c.review;
      expect(review, `${c.id} is reviewed without a review`).to.be.an("object");
      expect(
        Object.keys(review ?? {})
          .sort()
          .join(),
        c.id
      ).to.equal("by,date,method");
      expect(review?.by, c.id).to.be.a("string").and.not.equal("");
      expect(review?.method, c.id).to.be.a("string").and.not.equal("");
      expect(review?.method, c.id).to.match(
        /independently agreed the expected verdict, band and check ids/
      );
      expect(review?.date, c.id).to.match(ISO_DATE);
      expect(
        (review?.date ?? "") <= GOLDEN.labelCutoff,
        `${c.id} was reviewed after the label cutoff`
      ).to.equal(true);
      expect(c.expected_origin, c.id).to.match(/consult\(\) output/);
      expect(c.expected_origin, c.id).to.match(/independently agreed by the verifier/);
    });
  });

  it("never marks a known gap as reviewed", () => {
    GOLDEN.cases.forEach((c) => {
      if (c.known_gap === undefined) return;
      expect(c.reviewed, `${c.id} has a known gap`).to.equal(false);
      expect(Object.keys(c.known_gap).sort().join(), c.id).to.equal(
        "desired,reason"
      );
      expect(c.known_gap.desired, c.id).to.be.a("string").and.not.equal("");
      expect(c.known_gap.reason, c.id).to.be.a("string").and.not.equal("");
    });
  });

  it("gives every public source a url, a kind, one quote or line ref and a date", () => {
    GOLDEN.cases.forEach((c) => {
      if (typeof c.label_source === "string") return;
      const source = c.label_source;
      expect(Object.keys(source).sort(), c.id).to.satisfy(
        (keys: string[]) =>
          keys.join() === "kind,line_ref,retrieved,url" ||
          keys.join() === "kind,quote,retrieved,url"
      );
      expect(source.url, c.id).to.match(/^https:\/\/\S+$/);
      expect(SOURCE_KINDS, c.id).to.include(source.kind);
      expect(source.quote ?? source.line_ref, c.id)
        .to.be.a("string")
        .and.not.equal("");
      expect(source.retrieved, c.id).to.match(ISO_DATE);
      expect(source.retrieved <= GOLDEN.labelCutoff, c.id).to.equal(true);
    });
  });

  it("takes no label from a list the catalog imports", () => {
    expect(CATALOG_SOURCE_URLS.length).to.be.at.least(1);
    GOLDEN.cases.forEach((c) => {
      if (typeof c.label_source === "string") return;
      const url = withoutScheme(c.label_source.url);
      CATALOG_SOURCE_URLS.forEach((imported) => {
        expect(url.startsWith(imported), `${c.id} cites ${imported}`).to.equal(
          false
        );
      });
    });
  });

  it("records each chain read with its chain, endpoint, call, block and result", () => {
    GOLDEN.cases.forEach((c) => {
      if (c.chain_evidence === undefined) return;
      expect(c.label_source, c.id).to.be.an("object");
      expect(c.chain_evidence, c.id).to.be.an("array").that.is.not.empty;
      c.chain_evidence.forEach((read) => {
        expect(Object.keys(read).sort().join(), c.id).to.equal(
          "block,call,chainId,method,result,rpc"
        );
        expect(read.chainId, c.id).to.match(/^eip155:[1-9]\d*$/);
        expect(read.rpc, c.id).to.match(/^https:\/\/\S+$/);
        expect(read.method, c.id).to.match(/^eth_[A-Za-z]+$/);
        expect(read.call, c.id).to.be.a("string").and.not.equal("");
        expect(read.result, c.id).to.be.a("string").and.not.equal("");
        expect(
          Number.isSafeInteger(read.block) && read.block > 0,
          c.id
        ).to.equal(true);
      });
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
