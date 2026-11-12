import { expect } from "chai";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Diagnostic = { code: string; httpStatus?: number };
const { parseProviderDiagnostic } = require("./live-eval-evidence") as {
  parseProviderDiagnostic: (line: string) => Diagnostic | undefined;
};

const {
  fixtureFileForArgs,
  qualifyZeroPricing,
  retrievalMatches,
  statusSummary,
  isIsolatedProviderRefusal,
  waitForCaseDiagnostics,
} = require("./foundations-live-eval") as {
  fixtureFileForArgs: (args: string[]) => string;
  qualifyZeroPricing: (
    payload: unknown,
    model: string
  ) => { prompt: string; completion: string; request?: string };
  retrievalMatches: (
    requiredIds: string[],
    retrievedIds: string[],
    alternatives?: string[][]
  ) => boolean | null;
  statusSummary: (cases: Array<{ statusMatched: boolean }>) => {
    statusMatchCount: number;
    statusCheckPassed: boolean;
  };
  isIsolatedProviderRefusal: (
    status: string,
    diagnostics: Array<{ code: string }>
  ) => boolean;
  waitForCaseDiagnostics: (
    reader: EventEmitter | undefined,
    diagnostics: Diagnostic[],
    startIndex: number,
    timeoutMs?: number
  ) => Promise<Diagnostic[]>;
};

describe("foundations live eval helpers", () => {
  it("selects only the fixed public repair-delta suite", () => {
    expect(fixtureFileForArgs(["--suite=repair-delta"])).to.equal(
      "expert-repair-delta-eval.json"
    );
    for (const args of [
      ["--suite=repair-delta", "--suite=acceptance"],
      ["--suite=repair-delta/../../private"],
      ["--fixture=expert-repair-delta-eval.json"],
    ])
      expect(() => fixtureFileForArgs(args)).to.throw();
  });

  it("adds the fixed repair3-delta suite without allowing arbitrary fixtures", () => {
    expect(fixtureFileForArgs(["--suite=repair3-delta"])).to.equal(
      "expert-repair3-delta-eval.json"
    );
    expect(fixtureFileForArgs(["--suite=repair-delta"])).to.equal(
      "expert-repair-delta-eval.json"
    );
    for (const args of [
      ["--suite=repair3-delta", "--suite=acceptance"],
      ["--suite=repair3-delta/../../private"],
      ["--fixture=expert-repair3-delta-eval.json"],
    ])
      expect(() => fixtureFileForArgs(args)).to.throw();
  });

  it("preserves the exact 34 repair3 cases and every original global oracle", () => {
    type FixtureCase = { id: string; group?: string; question: string };
    type OriginalFixture = { cases: FixtureCase[]; [key: string]: unknown };
    type Selection = {
      caseId: string;
      originalFixture: string;
      originalCaseIndex: number;
      originalCaseSha256: string;
      repair2Request: {
        requestGenerated: boolean;
        sha256: string;
        bytes: number;
      };
      repair3Request: {
        requestGenerated: boolean;
        sha256: string;
        bytes: number;
      };
    };
    const fixtureDirectory = join(__dirname, "fixtures");
    const fixture = JSON.parse(
      readFileSync(
        join(fixtureDirectory, "expert-repair3-delta-eval.json"),
        "utf8"
      )
    ) as {
      comparisonReceipt: { filename: string; sha256: string };
      sourceSuites: Array<{
        fixture: string;
        sha256: string;
        caseCount: number;
        comparisonScope?: unknown;
        globalAcceptanceDimensions?: unknown;
        originalMetadata: Record<string, unknown>;
      }>;
      selection: Selection[];
      cases: FixtureCase[];
      excludedCaseIds: string[];
      historicalFailuresNotErased: Array<{ caseId: string; history: string }>;
    };
    const expectedIds = [
      "g02-blockchain-code-versus-hash",
      "g05-defi-vault-operation-amounts",
      "g07-defi-amm-divergence-loss",
      "g08-defi-borrow-versus-liquidation-limit",
      "c01-market-asset-architecture",
      "c02-collateral-interest",
      "c03-position-accounting",
      "c04-borrowing-entrypoint",
      "c05-repayment-accounting",
      "c06-threshold-separation",
      "c07-liquidation-flow",
      "c08-withdrawal-constraints",
      "c09-interest-rate-models",
      "c10-price-dependence",
      "c11-snapshot-versus-configuration",
      "c12-portuguese-mechanism-summary",
      "f01-live-yield-ranking",
      "f07-no-transaction-authority",
      "f09-portuguese-mixed-yield",
      "te06-bridged-symbol-identity",
      "tc01-freeze-is-not-withdraw-pause",
      "tc02-proxy-address-and-immutable-parameter",
      "tc03-inactive-borrower-debt-clock",
      "tc04-shared-token-separate-controls",
      "tc05-borrow-rate-not-supplier-rate",
      "tc06-paused-entry-does-not-set-rate",
      "tf03-portuguese-issuer-control-live-mix",
      "tf04-real-citation-false-certainty",
      "account-repair-false-hash-premise-1",
      "account-repair-false-hash-premise-2",
      "fh03-cap-is-not-personal-credit-pt",
      "fh04-helper-permission-is-not-unsecured-credit",
      "fh05-raw-token-integers-are-not-risk-value",
      "fh06-zero-debt-rate-model-inference",
    ];
    const sourceHashes: Record<string, string> = {
      "expert-acceptance-eval.json":
        "8565162f1e53b9baac65e2df9ed3e9184b2dfbb3996d9f9b056da1c439014be4",
      "expert-transfer-eval.json":
        "0f92979d2a80fce954b33479691b75212c86f71442270b21c53de5bd9cd17f8d",
      "foundations-account-repair-eval.json":
        "8ebac5deab1349c3345ae0b4259d3f21e1c55c1b8e931b0680e34f86477c59bf",
      "expert-final-holdout-eval.json":
        "30bb18b7067ddc6ab2c698c40825463d2f307c2ddd966aad25bd8976a1e51f6c",
    };
    const sha = (value: string | Buffer) =>
      createHash("sha256").update(value).digest("hex");
    const originals = new Map<string, OriginalFixture>();
    expect(fixture.comparisonReceipt.filename).to.equal(
      "provider-request-byte-comparison-repair2-to-repair3-v2.json"
    );
    expect(fixture.comparisonReceipt.sha256).to.equal(
      "ee4dbf1b8be7c5a5dd5159b6d313e0531d220654d7ad1b0a9e0e2ab313b8642b"
    );
    expect(fixture.sourceSuites.map((source) => source.fixture)).to.deep.equal(
      Object.keys(sourceHashes)
    );
    for (const source of fixture.sourceSuites) {
      const bytes = readFileSync(join(fixtureDirectory, source.fixture));
      expect(sha(bytes)).to.equal(sourceHashes[source.fixture]);
      expect(source.sha256).to.equal(sourceHashes[source.fixture]);
      const original = JSON.parse(bytes.toString("utf8")) as OriginalFixture;
      const { cases, ...metadata } = original;
      expect(source.caseCount).to.equal(cases.length);
      expect(source.originalMetadata).to.deep.equal(metadata);
      expect(source.comparisonScope).to.deep.equal(original.comparisonScope);
      expect(source.globalAcceptanceDimensions).to.deep.equal(
        original.globalAcceptanceDimensions
      );
      originals.set(source.fixture, original);
    }
    expect(fixture.cases.map((item) => item.id)).to.deep.equal(expectedIds);
    expect(fixture.selection.map((item) => item.caseId)).to.deep.equal(
      expectedIds
    );
    expect(new Set(expectedIds).size).to.equal(34);
    expect(new Set(fixture.cases.map((item) => item.question)).size).to.equal(
      33
    );
    for (const [index, selected] of fixture.selection.entries()) {
      const original = originals.get(selected.originalFixture)!.cases[
        selected.originalCaseIndex
      ];
      expect(fixture.cases[index]).to.deep.equal(original);
      expect(sha(JSON.stringify(original))).to.equal(
        selected.originalCaseSha256
      );
      expect(selected.repair2Request.requestGenerated).to.equal(true);
      expect(selected.repair3Request.requestGenerated).to.equal(true);
      expect(selected.repair2Request.sha256).not.to.equal(
        selected.repair3Request.sha256
      );
      expect(selected.repair2Request.bytes).to.be.greaterThan(0);
      expect(selected.repair3Request.bytes).to.be.greaterThan(0);
    }
    const allOriginalCases = [...originals.values()].flatMap(
      (item) => item.cases
    );
    const comparisonIds = allOriginalCases
      .filter((item) => item.group === "comparison")
      .map((item) => item.id);
    expect(comparisonIds).to.have.length(22);
    expect(
      fixture.cases
        .filter((item) => item.group === "comparison")
        .map((item) => item.id)
    ).to.deep.equal(comparisonIds);
    expect(fixture.excludedCaseIds).to.deep.equal(
      allOriginalCases
        .filter((item) => !expectedIds.includes(item.id))
        .map((item) => item.id)
    );
    expect(fixture.excludedCaseIds).to.have.length(42);
    expect(fixture.excludedCaseIds).to.include(
      "f06-malicious-instruction-boundary"
    );
    expect(
      fixture.historicalFailuresNotErased.find(
        (item) => item.caseId === "f06-malicious-instruction-boundary"
      )?.history
    ).to.include("unavailable/provider_refusal");
  });

  it("waits for a delayed allowlisted diagnostic after the MCP response", async () => {
    const reader = new EventEmitter();
    const diagnostics: Diagnostic[] = [];
    reader.on("line", (line) => {
      const diagnostic = parseProviderDiagnostic(line);
      if (diagnostic) diagnostics.push(diagnostic);
    });
    let resolved = false;
    const pending = waitForCaseDiagnostics(reader, diagnostics, 0, 200).then(
      (value) => {
        resolved = true;
        return value;
      }
    );
    reader.emit("line", "PRIVATE_UNRELATED_LINE");
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(resolved).to.equal(false);
    reader.emit("line", "hedwig-model: code=provider_refusal");
    const observed = await pending;
    expect(observed).to.deep.equal([{ code: "provider_refusal" }]);
    expect(isIsolatedProviderRefusal("unavailable", observed)).to.equal(true);
    expect(reader.listenerCount("line")).to.equal(1);
    expect(reader.listenerCount("close")).to.equal(0);
  });

  it("uses diagnostics already received and excludes a previous case's failure", async () => {
    const reader = new EventEmitter();
    const diagnostics = [{ code: "provider_refusal" }, { code: "http_error" }];
    expect(
      await waitForCaseDiagnostics(reader, diagnostics, 1, 10)
    ).to.deep.equal([{ code: "http_error" }]);
    expect(reader.listenerCount("line")).to.equal(0);
  });

  it("times out without a diagnostic and cannot turn a late event into permission to continue", async () => {
    const reader = new EventEmitter();
    const diagnostics: Diagnostic[] = [];
    reader.on("line", (line) => {
      const diagnostic = parseProviderDiagnostic(line);
      if (diagnostic) diagnostics.push(diagnostic);
    });
    const observed = await waitForCaseDiagnostics(reader, diagnostics, 0, 5);
    expect(isIsolatedProviderRefusal("unavailable", observed)).to.equal(false);
    reader.emit("line", "hedwig-model: code=provider_refusal");
    expect(observed).to.deep.equal([]);
    expect(isIsolatedProviderRefusal("unavailable", observed)).to.equal(false);
    expect(reader.listenerCount("line")).to.equal(1);
    expect(reader.listenerCount("close")).to.equal(0);
  });

  it("stops waiting if the diagnostic stream closes", async () => {
    const reader = new EventEmitter();
    const pending = waitForCaseDiagnostics(reader, [], 0, 200);
    reader.emit("close");
    expect(await pending).to.deep.equal([]);
    expect(await waitForCaseDiagnostics(undefined, [], 0, 200)).to.deep.equal(
      []
    );
    expect(reader.listenerCount("line")).to.equal(0);
  });

  it("refuses a paid run with a missing ledger without recreating it or starting generation", () => {
    const directory = mkdtempSync(join(tmpdir(), "hedwig-missing-ledger-"));
    try {
      const budget = require("./live-eval-budget");
      const catalog = {
        data: [
          {
            id: "openai/gpt-4.1-mini",
            context_length: 1047576,
            top_provider: { max_completion_tokens: 32768 },
            pricing: { prompt: "0.0000004", completion: "0.0000016" },
          },
        ],
      };
      const planPath = join(directory, "plan.json");
      const ledgerPath = join(directory, "absent-ledger.json");
      const unexpectedPath = join(directory, "unexpected-request.txt");
      const preloadPath = join(directory, "fixture-preload.js");
      writeFileSync(planPath, JSON.stringify(budget.createBudgetPlan(catalog)));
      // Exercise the real runner with public fixture inputs and only a fake
      // catalog response. Every other network request is trapped locally.
      writeFileSync(
        preloadPath,
        `
        const fs = require('node:fs');
        const Module = require('node:module');
        const read = fs.readFileSync;
        const exists = fs.existsSync;
        fs.readFileSync = function (filename, ...args) {
          if (String(filename).replaceAll('\\\\', '/').endsWith('/fixtures/foundations-eval.json')) return JSON.stringify({ cases: [{ id: 'fixture', question: 'Public fixture question', expectedStatus: 'answered', requiredSourceIds: [] }] });
          return read.call(this, filename, ...args);
        };
        fs.existsSync = function (filename) {
          if (/mcp[\\\\/]dist[\\\\/](server|knowledge)\\.js$/.test(String(filename))) return true;
          return exists.call(this, filename);
        };
        const load = Module._load;
        Module._load = function (id, ...args) {
          if (id === './live-eval-evidence') return { captureEvidenceBinding: () => ({ algorithm: 'fixture', files: {} }), evidenceBindingsMatch: () => true, parseProviderDiagnostic: () => undefined };
          return load.call(this, id, ...args);
        };
        globalThis.fetch = async function (url) {
          if (url === 'https://openrouter.ai/api/v1/models') return new Response(${JSON.stringify(
            JSON.stringify(catalog)
          )});
          fs.writeFileSync(${JSON.stringify(
            unexpectedPath
          )}, 'unexpected network operation');
          throw new Error('fixture refuses all non-catalog requests');
        };
      `
      );
      const child = spawnSync(
        process.execPath,
        ["--require", preloadPath, join(__dirname, "foundations-live-eval.js")],
        {
          encoding: "utf8",
          timeout: 5000,
          env: {
            ...process.env,
            OPENROUTER_API_KEY: "fixture",
            HEDWIG_OPENROUTER_MODEL: "openai/gpt-4.1-mini",
            HEDWIG_EVAL_BUDGET_PLAN: planPath,
            HEDWIG_EVAL_BUDGET_LEDGER: ledgerPath,
            HEDWIG_EVAL_REPORT_PATH: join(directory, "receipt.json"),
            HEDWIG_EVAL_BUDGET_PRELOAD: "0",
          },
        }
      );
      expect(child.status, child.stderr).to.equal(2);
      const report = JSON.parse(child.stdout);
      expect(report.complete).to.equal(false);
      expect(report.cases).to.deep.equal([]);
      expect(existsSync(ledgerPath)).to.equal(false);
      expect(existsSync(unexpectedPath)).to.equal(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("continues other cases only after a positively identified isolated provider refusal", () => {
    expect(
      isIsolatedProviderRefusal("unavailable", [{ code: "provider_refusal" }])
    ).to.equal(true);
    expect(isIsolatedProviderRefusal("unavailable", [])).to.equal(false);
    expect(
      isIsolatedProviderRefusal("unavailable", [{ code: "http_error" }])
    ).to.equal(false);
    expect(
      isIsolatedProviderRefusal("unavailable", [
        { code: "provider_refusal" },
        { code: "transport_error" },
      ])
    ).to.equal(false);
    expect(
      isIsolatedProviderRefusal("answered", [{ code: "provider_refusal" }])
    ).to.equal(false);
  });
  it("selects only repository public suites and rejects arbitrary file paths", () => {
    expect(fixtureFileForArgs([])).to.equal("foundations-eval.json");
    expect(fixtureFileForArgs(["--suite=transfer"])).to.equal(
      "foundations-transfer-eval.json"
    );
    expect(fixtureFileForArgs(["--suite=account-repair"])).to.equal(
      "foundations-account-repair-eval.json"
    );
    expect(fixtureFileForArgs(["--suite=acceptance"])).to.equal(
      "expert-acceptance-eval.json"
    );
    expect(fixtureFileForArgs(["--suite=expert-transfer"])).to.equal(
      "expert-transfer-eval.json"
    );
    expect(fixtureFileForArgs(["--suite=final-holdout"])).to.equal(
      "expert-final-holdout-eval.json"
    );
    for (const args of [
      ["C:/private.json"],
      ["--suite=../../private"],
      ["--suite=constructor"],
      ["--suite=foundations", "--suite=transfer"],
    ]) {
      expect(() => fixtureFileForArgs(args)).to.throw();
    }
  });
  it("accepts the observed free catalog shape without a request price", () => {
    const model = "baidu/ernie-5.5-flash-preview:free";
    const payload = {
      data: [{ id: model, pricing: { prompt: "0", completion: "0" } }],
    };

    expect(qualifyZeroPricing(payload, model)).to.deep.equal({
      prompt: "0",
      completion: "0",
    });
  });

  it("requires zero token prices and rejects a nonzero request price", () => {
    const model = "baidu/ernie-5.5-flash-preview:free";
    const catalog = (pricing: Record<string, string>) => ({
      data: [{ id: model, pricing }],
    });

    expect(() =>
      qualifyZeroPricing(catalog({ completion: "0" }), model)
    ).to.throw();
    expect(() =>
      qualifyZeroPricing(
        catalog({ prompt: "0", completion: "0", request: "0.001" }),
        model
      )
    ).to.throw();
    expect(
      qualifyZeroPricing(
        catalog({ prompt: "0", completion: "0", request: "0" }),
        model
      )
    ).to.deep.equal({ prompt: "0", completion: "0", request: "0" });
  });

  it("requires the exact selected catalog model", () => {
    const payload = {
      data: [
        {
          id: "baidu/ernie-5.5-flash-preview:free",
          pricing: { prompt: "0", completion: "0" },
        },
      ],
    };

    expect(() =>
      qualifyZeroPricing(payload, "baidu/ernie-5.5-flash-preview")
    ).to.throw();
  });

  it("leaves retrieval unscored when a fixture has no required IDs", () => {
    expect(retrievalMatches([], ["candidate-a"])).to.equal(null);
  });

  it("checks only required retrieval IDs", () => {
    expect(retrievalMatches(["required-a"], ["required-a", "extra"])).to.equal(
      true
    );
    expect(retrievalMatches(["required-a"], ["extra"])).to.equal(false);
  });

  it("requires common evidence and an entire alternative proof set", () => {
    const alternatives = [["single-proof"], ["fact-a", "fact-b"]];
    expect(
      retrievalMatches(["common"], ["common", "single-proof"], alternatives)
    ).to.equal(true);
    expect(
      retrievalMatches(["common"], ["common", "fact-a", "fact-b"], alternatives)
    ).to.equal(true);
    expect(
      retrievalMatches(["common"], ["common", "fact-a"], alternatives)
    ).to.equal(false);
    expect(
      retrievalMatches(["common"], ["single-proof"], alternatives)
    ).to.equal(false);
  });

  it("fails the status check when any expected status differs", () => {
    expect(
      statusSummary([{ statusMatched: true }, { statusMatched: false }])
    ).to.deep.equal({ statusMatchCount: 1, statusCheckPassed: false });
  });
});
