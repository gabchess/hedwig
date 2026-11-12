import { expect } from "chai";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const budget = require("./live-eval-budget.js");
const helper = resolve(__dirname, "live-eval-budget.js");
const requestedModel = "deepseek/deepseek-v4-flash-0731";
const canonicalModel = "deepseek/deepseek-v4-flash-20260731";
const identity = {
  schemaVersion: 1,
  provider: "openrouter",
  endpoint: "https://openrouter.ai/api/v1/models",
  httpStatus: 200,
  retrievedAt: "2026-11-12T21:20:46.611Z",
  providerResponseSha256:
    "9b2a13b2d8ba140a4331ba70692043345c9bc638fed6b5d766c4c34bcea9064b",
  data: { id: requestedModel, canonical_slug: canonicalModel },
};
const rawHash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}
function save(file: string, ledger: any) {
  const { integrity: ignored, ...content } = ledger;
  writeFileSync(
    file,
    JSON.stringify({
      ...content,
      integrity: rawHash(JSON.stringify(canonical(content))),
    })
  );
}
function rehash(operation: any) {
  operation.expectedReceiptSha256 = rawHash(operation.receiptJson);
  operation.expectedAttributionSha256 = rawHash(operation.attributionJson);
  return operation;
}

describe("catalog-bound DeepSeek Flash cost reconciliation", () => {
  let directory: string, ledgerPath: string, plan: any;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "hedwig-deepseek-reconciliation-"));
    ledgerPath = join(directory, "ledger.json");
    const initial = budget.createBudgetPlan(
      {
        id: "openai/gpt-5.2",
        context_length: 400000,
        top_provider: { max_completion_tokens: 128000 },
        pricing: { prompt: "0.00000175", completion: "0.000014" },
      },
      "openai/gpt-5.2"
    );
    budget.initializeBudgetLedger(ledgerPath, initial);
    const ledger = read(ledgerPath);
    ledger.entries = [
      {
        id: "historical-unknown",
        planHash: initial.planHash,
        maxTokens: 6144,
        reservedNanoUsd: 786016000,
        status: "uncertain",
        recovery: {
          disposition: "full_reservation_accounted",
          recoveryId: randomUUID(),
          entryId: "historical-unknown",
          previousStatus: "reserved",
          previousLedgerIntegrity: "a".repeat(64),
          lockSha256: "b".repeat(64),
          ownerPid: 12345,
          reservedNanoUsd: 786016000,
          recoveredAt: "2026-11-12T18:00:00.000Z",
        },
      },
    ];
    save(ledgerPath, ledger);
    const extended = budget.extendBudgetCap(ledgerPath, initial, {
      authorizationId: randomUUID(),
      approvedAt: "2026-11-12T19:00:00.000Z",
      approvalReference: "disposable-test-only",
      expectedLedgerIntegrity: read(ledgerPath).integrity,
      approvedTotalNanoUsd: 6e9,
    }).plan;
    plan = budget.applyBudgetModelAmendment(
      ledgerPath,
      extended,
      {
        id: requestedModel,
        context_length: 1048576,
        top_provider: { max_completion_tokens: 943718 },
        pricing: {
          prompt: "0.0000000434",
          completion: "0.0000003",
          input_cache_read: "0.000000035",
        },
      },
      {
        amendmentId: randomUUID(),
        amendedAt: "2026-11-12T20:46:40.520Z",
        approvalReference: "disposable-test-only",
        expectedLedgerIntegrity: read(ledgerPath).integrity,
        model: requestedModel,
      }
    ).plan;
    await budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () =>
        new Response(JSON.stringify({ id: "gen-deepseek-fixture" }), {
          headers: { "X-Generation-Id": "gen-deepseek-fixture" },
        }),
    })("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: requestedModel,
        stream: false,
        reasoning: { effort: "high", exclude: true },
        max_tokens: 8192,
        provider: {
          require_parameters: true,
          allow_fallbacks: false,
          data_collection: "deny",
          zdr: true,
        },
        messages: [
          {
            role: "user",
            content: "Public disposable fixture, no provider call.",
          },
        ],
        response_format: { type: "json_schema", json_schema: {} },
      }),
    });
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function operation() {
    const ledger = read(ledgerPath),
      entry = ledger.entries.at(-1),
      now = new Date().toISOString();
    return rehash({
      reconciliationId: randomUUID(),
      expectedLedgerIntegrity: ledger.integrity,
      expectedEntryId: entry.id,
      expectedReservationNanoUsd: entry.reservedNanoUsd,
      receiptJson: JSON.stringify({
        schemaVersion: 1,
        provider: "openrouter",
        endpoint: "https://openrouter.ai/api/v1/generation",
        httpStatus: 200,
        retrievedAt: now,
        modelIdentity: identity,
        data: {
          id: "gen-deepseek-fixture",
          model: canonicalModel,
          api_type: "completions",
          created_at: entry.requestedAt,
          total_cost: 0.0007712,
          usage: 0.0007712,
          cancelled: true,
          finish_reason: null,
        },
      }),
      attributionJson: JSON.stringify({
        entryId: entry.id,
        generationId: "gen-deepseek-fixture",
        model: requestedModel,
        method: "captured_generation_id",
        operatorReference: "disposable-test-only/not-real-provider-proof",
        reviewedAt: now,
        uniqueMatchConfirmed: true,
        finalCostConfirmed: true,
        providerResponseSha256: "c".repeat(64),
        matchEvidenceSha256: "d".repeat(64),
      }),
    });
  }

  it("retains the genuine canonical model and both histories while settling only the captured DeepSeek Flash generation", () => {
    const before = read(ledgerPath),
      op = operation();
    budget.reconcileBudgetEntry(ledgerPath, plan, op);
    const after = read(ledgerPath),
      entry = after.entries.at(-1);
    expect(after.entries.slice(0, -1)).to.deep.equal(
      before.entries.slice(0, -1)
    );
    for (const key of [
      "schemaVersion",
      "planHash",
      "capNanoUsd",
      "planHistory",
      "capAuthorizations",
      "modelAmendments",
    ])
      expect(after[key]).to.deep.equal(before[key]);
    expect(entry.costNanoUsd).to.equal(771200);
    expect(entry.reconciliation.originalEntry).to.deep.equal(
      before.entries.at(-1)
    );
    expect(JSON.parse(entry.reconciliation.receiptJson).data.model).to.equal(
      canonicalModel
    );
    expect(entry.reconciliation.receiptJson).to.equal(op.receiptJson);
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        "const b=require(process.argv[1]);console.log(JSON.stringify(b.readBudgetSummary(process.argv[2],JSON.parse(process.argv[3]))))",
        helper,
        ledgerPath,
        JSON.stringify(plan),
      ],
      { encoding: "utf8", timeout: 5000 }
    );
    expect(child.status, child.stderr).to.equal(0);
    expect(JSON.parse(child.stdout)).to.include({
      spentUsd: 0.0007712,
      reservedUsd: 0.786016,
      blocked: false,
    });
  });

  it("rejects unreviewed aliases, cross-model catalog bindings and invalid finality without writes", () => {
    const before = readFileSync(ledgerPath);
    const changes: Array<(receipt: any, attribution: any) => void> = [
      (r) => {
        r.modelIdentity.httpStatus = 201;
      },
      (r) => {
        r.modelIdentity.provider = "other";
      },
      (r) => {
        r.modelIdentity.endpoint = "https://example.invalid/models";
      },
      (r) => {
        r.modelIdentity.schemaVersion = 2;
      },
      (r) => {
        r.data.model = r.modelIdentity.data.canonical_slug =
          "deepseek/deepseek-v4-pro-20260813";
      },
      (r) => {
        delete r.modelIdentity;
      },
      (r) => {
        r.data.model = requestedModel + ":free";
      },
      (r) => {
        r.data.model = r.modelIdentity.data.canonical_slug =
          "deepseek/deepseek-v4-flash-20260732";
      },
      (r) => {
        r.modelIdentity.data.id = "openai/gpt-5.2";
      },
      (r) => {
        r.modelIdentity.providerResponseSha256 =
          "43199a7f1e2e3aaac2e82c1e4d928671454ee8e620d5e53a9e3e1d9dd0886e1d";
      },
      (r) => {
        r.modelIdentity.retrievedAt = "2026-11-12T16:30:23.655Z";
      },
      (r) => {
        r.modelIdentity.retrievedAt = "2026-11-12T20:46:40.489Z";
      },
      (r) => {
        r.modelIdentity.data.extra = "unreviewed";
      },
      (r) => {
        r.data.model = requestedModel;
      },
      (r) => {
        r.data.id = "gen-different";
      },
      (r) => {
        r.data.total_cost = r.data.usage = 1;
      },
      (r) => {
        r.data.usage = 0;
      },
      (r) => {
        r.data.cancelled = false;
      },
      (r) => {
        r.data.created_at = "2026-01-01T00:00:00.000Z";
      },
      (r, a) => {
        a.reviewedAt = "2026-11-12T20:46:40.519Z";
      },
      (r, a) => {
        a.model = canonicalModel;
      },
    ];
    for (const change of changes) {
      const op = operation(),
        receipt = JSON.parse(op.receiptJson),
        attribution = JSON.parse(op.attributionJson);
      change(receipt, attribution);
      op.receiptJson = JSON.stringify(receipt);
      op.attributionJson = JSON.stringify(attribution);
      rehash(op);
      expect(() => budget.reconcileBudgetEntry(ledgerPath, plan, op)).to.throw(
        "invalid_reconciliation_evidence"
      );
      expect(readFileSync(ledgerPath)).to.deep.equal(before);
    }
  });

  it("continues to admit an exact requested model only when alias evidence is absent", () => {
    const op = operation(),
      receipt = JSON.parse(op.receiptJson);
    receipt.data.model = requestedModel;
    delete receipt.modelIdentity;
    op.receiptJson = JSON.stringify(receipt);
    rehash(op);
    budget.reconcileBudgetEntry(ledgerPath, plan, op);
    expect(budget.readBudgetSummary(ledgerPath, plan).blocked).to.equal(false);
  });

  it("revalidates the retained DeepSeek Flash identity after settlement", () => {
    budget.reconcileBudgetEntry(ledgerPath, plan, operation());
    const ledger = read(ledgerPath),
      record = ledger.entries.at(-1).reconciliation;
    const receipt = JSON.parse(record.receiptJson);
    receipt.modelIdentity.providerResponseSha256 = "f".repeat(64);
    record.receiptJson = JSON.stringify(receipt);
    record.receiptSha256 = rawHash(record.receiptJson);
    save(ledgerPath, ledger);
    expect(() => budget.readBudgetSummary(ledgerPath, plan)).to.throw(
      "invalid_reconciliation_evidence"
    );
  });
});
