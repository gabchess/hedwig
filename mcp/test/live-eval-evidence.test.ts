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
  captureEvidenceBinding: (root: string, fixture: string) => EvidenceBinding;
  evidenceBindingsMatch: (
    before: EvidenceBinding,
    after: EvidenceBinding
  ) => boolean;
};

describe("live evaluation evidence binding", () => {
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
      for (const file of helpers.EVIDENCE_FILES) {
        const target = join(root, file);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, file);
      }
      const fixture = "expert-acceptance-eval.json";
      mkdirSync(join(root, "mcp/test/fixtures"), { recursive: true });
      writeFileSync(join(root, "mcp/test/fixtures", fixture), "fixture-v1");
      const before = helpers.captureEvidenceBinding(root, fixture);
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
