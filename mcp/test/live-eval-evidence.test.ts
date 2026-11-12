import { expect } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type EvidenceBinding = { algorithm: string; files: Record<string, string> };
const helpers = require("./live-eval-evidence") as {
  EVIDENCE_FILES: readonly string[];
  parseProviderDiagnostic: (
    line: string
  ) => { code: string; httpStatus?: number } | undefined;
  parseBudgetDiagnostic: (line: string) => { code: string } | undefined;
  captureEvidenceBinding: (root: string, fixture: string) => EvidenceBinding;
  evidenceBindingsMatch: (
    before: EvidenceBinding,
    after: EvidenceBinding
  ) => boolean;
};

describe("live evaluation evidence binding", () => {
  it("separately admits fixed budget diagnostics without copying arbitrary stderr", () => {
    expect(helpers.parseBudgetDiagnostic).to.be.a("function");
    for (const code of [
      "cap_exhausted",
      "request_too_large",
      "request_uncertain",
      "cost_unverified",
      "ledger_failure",
    ])
      expect(
        helpers.parseBudgetDiagnostic(`hedwig-budget: code=${code}\r`)
      ).to.deep.equal({ code });
    for (const line of [
      "hedwig-budget: code=PRIVATE",
      "hedwig-budget: code=cap_exhausted secret=PRIVATE",
      "prefix hedwig-budget: code=cap_exhausted",
      "hedwig-model: code=transport_error",
      "hedwig-budget: code=cap_exhausted\nPRIVATE",
    ])
      expect(helpers.parseBudgetDiagnostic(line)).to.equal(undefined);
    expect(
      helpers.parseProviderDiagnostic("hedwig-budget: code=cap_exhausted")
    ).to.equal(undefined);
  });
  it("records only fixed diagnostic codes, never raw stderr content", () => {
    expect(helpers.parseProviderDiagnostic).to.be.a("function");
    expect(
      helpers.parseProviderDiagnostic("hedwig-model: code=rate_limited\r")
    ).to.deep.equal({ code: "rate_limited" });
    expect(
      helpers.parseProviderDiagnostic("hedwig-model: code=provider_refusal")
    ).to.deep.equal({ code: "provider_refusal" });
    expect(
      helpers.parseProviderDiagnostic("hedwig-model: code=request_too_large")
    ).to.deep.equal({ code: "request_too_large" });
    expect(
      helpers.parseProviderDiagnostic(
        "hedwig-model: code=http_error httpStatus=503"
      )
    ).to.deep.equal({ code: "http_error", httpStatus: 503 });
    for (const input of [
      "Bearer PRIVATE",
      "hedwig-model: code=PRIVATE",
      "hedwig-model: code=rate_limited secret=PRIVATE",
      "prefix hedwig-model: code=rate_limited",
      "hedwig-model: code=http_error httpStatus=503 PRIVATE",
      "hedwig-model: code=http_error httpStatus=999",
    ]) {
      expect(helpers.parseProviderDiagnostic(input)).to.equal(undefined);
    }
  });

  it("binds fixture and runtime bytes, and detects a changed corpus", () => {
    expect(helpers.captureEvidenceBinding).to.be.a("function");
    const root = mkdtempSync(join(tmpdir(), "hedwig-evidence-"));
    try {
      const requiredEvidenceFiles = [
        "mcp/dist/server.js",
        "mcp/dist/server-core.js",
        "mcp/dist/expert.js",
        "mcp/dist/expert-request.js",
        "mcp/dist/expert-workflow.js",
        "mcp/dist/foundation-answer.js",
        "mcp/dist/foundation-content.js",
        "mcp/src/foundation-pack-integrity.ts",
        "mcp/dist/foundation-pack-integrity.js",
        "mcp/dist/comparison-answer.js",
        "mcp/dist/knowledge.js",
        "mcp/dist/knowledge/foundations.json",
        "mcp/dist/openrouter.js",
        "mcp/dist/model-policy.js",
        "mcp/test/foundations-live-eval.js",
        "mcp/test/live-eval-evidence.js",
        "mcp/test/live-eval-budget.js",
        "mcp/test/live-eval-report.js",
      ];
      for (const file of requiredEvidenceFiles) {
        const target = join(root, file);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, file);
      }
      const fixture = "expert-acceptance-eval.json";
      mkdirSync(join(root, "mcp/test/fixtures"), { recursive: true });
      writeFileSync(join(root, "mcp/test/fixtures", fixture), "fixture-v1");
      const before = helpers.captureEvidenceBinding(root, fixture);
      expect(Object.keys(before.files)).to.have.members([
        ...requiredEvidenceFiles,
        "mcp/test/fixtures/" + fixture,
      ]);
      expect(before.algorithm).to.equal("sha256");
      expect(before.files["mcp/test/fixtures/" + fixture]).to.match(
        /^[a-f0-9]{64}$/
      );
      const corpus = "mcp/dist/knowledge/foundations.json";
      writeFileSync(join(root, corpus), "changed corpus");
      const after = helpers.captureEvidenceBinding(root, fixture);
      expect(helpers.evidenceBindingsMatch(before, before)).to.equal(true);
      expect(helpers.evidenceBindingsMatch(before, after)).to.equal(false);
      expect(after.files[corpus]).not.to.equal(before.files[corpus]);
      expect(after.files["mcp/dist/openrouter.js"]).to.equal(
        before.files["mcp/dist/openrouter.js"]
      );
      expect(() =>
        helpers.captureEvidenceBinding(root, "../../private.json")
      ).to.throw();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
