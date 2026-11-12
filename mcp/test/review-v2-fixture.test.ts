import { expect } from "chai";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { fixtureFileForArgs } = require("./foundations-live-eval") as {
  fixtureFileForArgs: (args: string[]) => string;
};
type Case = {
  id: string;
  requiredSourceIds: string[];
  requiredClaims?: string[];
  forbiddenClaims?: string[];
  [key: string]: unknown;
};
type Original = { cases: Case[]; [key: string]: unknown };
type Current = Original & {
  expectedCaseCount: number;
  qualificationState: string;
  sourceSuites: Array<{
    fixture: string;
    sha256: string;
    caseCount: number;
    originalMetadata: Record<string, unknown>;
  }>;
  caseProvenance: Array<{
    caseId: string;
    originalFixture: string;
    originalCaseIndex: number;
    originalCaseSha256: string;
    effectiveCaseSha256: string;
    disposition: string;
  }>;
  sourcePackBinding: {
    sha256: string;
    sourceCount: number;
    evidenceUnitCount: number;
  };
  primaryEvidence: Array<{
    sourceId: string;
    sourceFileUrl: string;
    sha256: string;
    gitBlobSha1: string;
  }>;
  evidenceUnits: Array<{ id: string; sourceId: string; summarySha256: string }>;
  oracleCorrections: Array<{
    caseId: string;
    oracleVersion: number;
    changedFields: string[];
    historicalReviewsPreserved: boolean;
  }>;
  reviewRegressionProvenance: {
    classification: string;
    caseSha256: Array<{ id: string; sha256: string }>;
  };
};
const directory = join(__dirname, "fixtures");
const read = (name: string) => readFileSync(join(directory, name));
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const current = JSON.parse(
  read("expert-review-v2-eval.json").toString("utf8")
) as Current;
const runBinding = JSON.parse(
  read("expert-review-v3-binding.json").toString("utf8")
) as {
  schemaVersion: number;
  kind: string;
  qualificationState: string;
  caseFixture: { file: string; sha256: string; expectedCaseCount: number };
  historicalSourcePackBinding: Current["sourcePackBinding"];
  sourcePackBinding: Current["sourcePackBinding"];
  addedEvidenceUnits: Array<{
    id: string;
    sourceId: string;
    summarySha256: string;
    unitSha256: string;
    sourceFileUrl: string;
    revision: string;
    gitBlobSha1: string;
    contentSha256: string;
    sections: Array<{ heading: string; lineStart: number; lineEnd: number }>;
  }>;
};
const originalHashes: Record<string, string> = {
  "expert-acceptance-eval.json":
    "8565162f1e53b9baac65e2df9ed3e9184b2dfbb3996d9f9b056da1c439014be4",
  "expert-transfer-eval.json":
    "0f92979d2a80fce954b33479691b75212c86f71442270b21c53de5bd9cd17f8d",
  "foundations-account-repair-eval.json":
    "8ebac5deab1349c3345ae0b4259d3f21e1c55c1b8e931b0680e34f86477c59bf",
  "expert-final-holdout-eval.json":
    "30bb18b7067ddc6ab2c698c40825463d2f307c2ddd966aad25bd8976a1e51f6c",
};
const correctedId = "fh04-helper-permission-is-not-unsecured-credit";
const addedEvidence = [
  "aave-v3-delegated-borrow-sequence",
  "aave-v3-credit-delegation-allowance",
  "aave-v3-borrow-capacity-checks",
];

describe("versioned current review qualification fixture", () => {
  it("selects the fixed current suite while rejecting arbitrary or combined arguments", () => {
    expect(fixtureFileForArgs(["--suite=review-v2"])).to.equal(
      "expert-review-v2-eval.json"
    );
    expect(fixtureFileForArgs(["--suite=review-v2-delta"])).to.equal(
      "expert-review-v2-delta-eval.json"
    );
    for (const args of [
      ["--suite=review-v2", "--suite=acceptance"],
      ["--suite=review-v2/../../private"],
      ["--fixture=expert-review-v2-eval.json"],
      ["--suite=review-v2-delta", "--suite=review-v2"],
      ["--suite=review-v2-delta/../../private"],
    ])
      expect(() => fixtureFileForArgs(args)).to.throw();
    expect(current.qualificationState).to.equal("not_live_qualified");
    expect(current.expectedCaseCount).to.equal(78);
    expect(current.cases).to.have.length(78);
    expect(new Set(current.cases.map((item) => item.id)).size).to.equal(78);
  });

  it("preserves all original files, global metadata, ordering and 75 unchanged cases", () => {
    expect(current.sourceSuites.map((source) => source.fixture)).to.deep.equal(
      Object.keys(originalHashes)
    );
    let index = 0;
    for (const source of current.sourceSuites) {
      const bytes = read(source.fixture);
      expect(sha(bytes)).to.equal(originalHashes[source.fixture]);
      expect(source.sha256).to.equal(originalHashes[source.fixture]);
      const { cases, ...metadata } = JSON.parse(
        bytes.toString("utf8")
      ) as Original;
      expect(source.caseCount).to.equal(cases.length);
      expect(source.originalMetadata).to.deep.equal(metadata);
      for (const [originalCaseIndex, original] of cases.entries()) {
        const effective = current.cases[index];
        const provenance = current.caseProvenance[index++];
        expect(effective.id).to.equal(original.id);
        expect(provenance).to.include({
          caseId: original.id,
          originalFixture: source.fixture,
          originalCaseIndex,
          originalCaseSha256: sha(JSON.stringify(original)),
          effectiveCaseSha256: sha(JSON.stringify(effective)),
        });
        if (original.id !== correctedId)
          expect(effective).to.deep.equal(original);
        else {
          expect(Object.keys(effective)).to.deep.equal(Object.keys(original));
          for (const key of Object.keys(original)) {
            if (
              ![
                "requiredClaims",
                "forbiddenClaims",
                "requiredSourceIds",
              ].includes(key)
            )
              expect(effective[key], key).to.deep.equal(original[key]);
          }
          expect(effective.requiredClaims!.slice(1)).to.deep.equal(
            original.requiredClaims!.slice(1)
          );
          expect(
            effective.forbiddenClaims!.slice(
              0,
              original.forbiddenClaims!.length
            )
          ).to.deep.equal(original.forbiddenClaims);
          expect(effective.requiredSourceIds).to.deep.equal([
            ...original.requiredSourceIds,
            ...addedEvidence,
          ]);
          expect(sha(JSON.stringify(effective))).to.equal(
            "a87553c162c92b4d7fe3f79fd095da6f7a12018069b6f359eebfe8f95e3ae1d1"
          );
        }
      }
    }
    expect(index).to.equal(76);
    expect(current.oracleCorrections).to.have.length(1);
    expect(current.oracleCorrections[0]).to.include({
      caseId: correctedId,
      oracleVersion: 2,
      historicalReviewsPreserved: true,
    });
    expect(current.oracleCorrections[0].changedFields).to.deep.equal([
      "requiredClaims[0]",
      "forbiddenClaims",
      "requiredSourceIds",
    ]);
  });

  it("binds the corrected borrowing chain and exposed regressions to reviewed source bytes", () => {
    const corpusBytes = readFileSync(
      join(__dirname, "../src/knowledge/foundations.json")
    );
    const corpus = JSON.parse(corpusBytes.toString("utf8")) as {
      sources: Array<{
        sourceId: string;
        contentSha256: string;
        blobSha: string;
        sourceFileUrl: string;
        revision: string;
        chunks: Array<{ id: string; text: string; sections: unknown[] }>;
      }>;
    };
    expect(runBinding).to.include({
      schemaVersion: 1,
      kind: "source_pack_run_binding",
      qualificationState: "not_live_qualified",
    });
    expect(runBinding.caseFixture).to.deep.equal({
      file: "mcp/test/fixtures/expert-review-v2-eval.json",
      sha256:
        "0a63658a62109ffa57e6753bc4c765550088e30ba1234e02c91eebd2688d6139",
      expectedCaseCount: 78,
    });
    expect(sha(read("expert-review-v2-eval.json"))).to.equal(
      runBinding.caseFixture.sha256
    );
    expect(current.cases).to.have.length(
      runBinding.caseFixture.expectedCaseCount
    );
    expect(runBinding.historicalSourcePackBinding).to.deep.equal(
      current.sourcePackBinding
    );
    expect(sha(corpusBytes)).to.equal(runBinding.sourcePackBinding.sha256);
    expect(corpus.sources).to.have.length(
      runBinding.sourcePackBinding.sourceCount
    );
    expect(corpus.sources.flatMap((source) => source.chunks)).to.have.length(
      runBinding.sourcePackBinding.evidenceUnitCount
    );
    expect(current.primaryEvidence).to.have.length(8);
    for (const evidence of current.primaryEvidence) {
      const source = corpus.sources.find(
        (item) => item.sourceId === evidence.sourceId
      )!;
      expect(source).to.include({
        contentSha256: evidence.sha256,
        blobSha: evidence.gitBlobSha1,
        sourceFileUrl: evidence.sourceFileUrl,
      });
    }
    for (const evidence of current.evidenceUnits) {
      const source = corpus.sources.find(
        (item) => item.sourceId === evidence.sourceId
      )!;
      const chunk = source.chunks.find((item) => item.id === evidence.id)!;
      expect(sha(chunk.text)).to.equal(evidence.summarySha256);
    }
    expect(current.evidenceUnits.map((unit) => unit.id)).to.include.members(
      addedEvidence
    );
    expect(runBinding.addedEvidenceUnits.map((unit) => unit.id)).to.deep.equal([
      "aave-v3-reserve-borrow-eligibility",
    ]);
    for (const evidence of runBinding.addedEvidenceUnits) {
      const source = corpus.sources.find(
        (item) => item.sourceId === evidence.sourceId
      )!;
      const matches = source.chunks.filter((item) => item.id === evidence.id);
      expect(matches).to.have.length(1);
      const chunk = matches[0];
      expect(source).to.include({
        sourceFileUrl: evidence.sourceFileUrl,
        revision: evidence.revision,
        blobSha: evidence.gitBlobSha1,
        contentSha256: evidence.contentSha256,
      });
      expect(sha(chunk.text)).to.equal(evidence.summarySha256);
      expect(sha(JSON.stringify(chunk))).to.equal(evidence.unitSha256);
      expect(chunk.sections).to.deep.equal(evidence.sections);
      source.chunks = source.chunks.filter((item) => item.id !== evidence.id);
    }
    // Removing only the declared addition must reproduce every historical
    // source, unit and metadata field, in their original order and formatting.
    expect(sha(JSON.stringify(corpus, null, 2) + "\n")).to.equal(
      current.sourcePackBinding.sha256
    );
  });

  it("retains both exposed review regressions without describing them as a fresh holdout", () => {
    const expected = [
      {
        id: "rr01-usdc-token-address-role",
        sha256:
          "902efca62c9d4e314c6dd0dd08dc1e49a3267ce22840f1588ecccdd9e46b100a",
      },
      {
        id: "rr02-compound-only-collateral-interest",
        sha256:
          "4c0209523da23769c418533fa8939687c5c88a8dc3a0554fa3d24e321f58c112",
      },
    ];
    expect(current.reviewRegressionProvenance.classification).to.equal(
      "exposed_review_regressions_not_holdout"
    );
    expect(current.reviewRegressionProvenance.caseSha256).to.deep.equal(
      expected
    );
    expect(
      current.cases
        .slice(76)
        .map((item) => ({ id: item.id, sha256: sha(JSON.stringify(item)) }))
    ).to.deep.equal(expected);
    for (const provenance of current.caseProvenance.slice(76))
      expect(provenance.disposition).to.equal(
        "exposed_review_regression_not_holdout"
      );
  });
});
