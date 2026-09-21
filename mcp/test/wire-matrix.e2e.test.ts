import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";

import { SERVER_PATH, assertServerBuilt, VALID_POLICY } from "./e2e-helpers";

const CLIENT_SCRIPT = join(__dirname, "wire-matrix-client.js");

interface ToolResult {
  isError?: boolean;
  structuredContent?: { verdict: string; results: { id: string }[] };
}

describe("wire-level failure matrix, driven over the real built server", function () {
  this.timeout(20000);

  before(assertServerBuilt);

  let dir: string;
  let output: {
    results: Array<{
      label: string;
      rowResult: ToolResult;
      sanityResult: ToolResult;
    }>;
    stderr: string;
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-mcp-wire-matrix-"));
    const policyPath = join(dir, "policy.json");
    writeFileSync(policyPath, JSON.stringify(VALID_POLICY));

    const raw = execFileSync(
      process.execPath,
      [CLIENT_SCRIPT, SERVER_PATH, policyPath],
      { encoding: "utf8" }
    );
    output = JSON.parse(raw);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers every malformed row as a normal, non-error result", () => {
    output.results.forEach(({ label, rowResult }) => {
      expect(rowResult.isError, `${label}: isError`).to.not.equal(true);
    });
  });

  it("answers every malformed row with UNKNOWN, never ALLOW or an MCP error", () => {
    output.results.forEach(({ label, rowResult }) => {
      expect(
        rowResult.structuredContent?.verdict,
        `${label}: verdict`
      ).to.equal("UNKNOWN");
    });
  });

  it("names the defect with the adapter's own id or the core's input-shape id", () => {
    output.results.forEach(({ label, rowResult }) => {
      const ids = (rowResult.structuredContent?.results ?? []).map(
        (entry) => entry.id
      );
      expect(ids, label).to.satisfy(
        (idList: string[]) =>
          idList.includes("adapter") || idList.includes("input-shape")
      );
    });
  });

  it("keeps answering correctly after every malformed row", () => {
    output.results.forEach(({ label, sanityResult }) => {
      expect(sanityResult.isError, `${label}: sanity isError`).to.equal(false);
      expect(
        sanityResult.structuredContent?.verdict,
        `${label}: sanity verdict`
      ).to.equal("ALLOW_UNDER_POLICY");
    });
  });
});
