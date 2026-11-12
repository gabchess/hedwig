import { expect } from "chai";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const budget = require("./live-eval-budget.js");
const helper = resolve(__dirname, "live-eval-budget.js");
const endpoint = "https://openrouter.ai/api/v1/chat/completions";
const catalog = {
  id: "openai/gpt-5.2",
  context_length: 400000,
  top_provider: { max_completion_tokens: 128000 },
  pricing: { prompt: "0.00000175", completion: "0.000014" },
};
const originalPlan = budget.createBudgetPlan(catalog, catalog.id);
const reservedNanoUsd = 786016000;
const requestBody = {
  method: "POST",
  body: JSON.stringify({
    model: catalog.id,
    stream: false,
    max_tokens: 6144,
    reasoning: { effort: "medium", exclude: true },
    provider: {
      require_parameters: true,
      allow_fallbacks: false,
      data_collection: "deny",
      zdr: true,
    },
    messages: [
      { role: "user", content: "Public disposable reconciliation fixture." },
    ],
    response_format: { type: "json_schema", json_schema: {} },
  }),
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
function save(file: string, value: any) {
  const { integrity: _integrity, ...content } = value;
  writeFileSync(
    file,
    JSON.stringify({
      ...content,
      integrity: rawHash(JSON.stringify(canonical(content))),
    })
  );
}
function rehash(request: any) {
  request.expectedReceiptSha256 = rawHash(request.receiptJson);
  request.expectedAttributionSha256 = rawHash(request.attributionJson);
  return request;
}

describe("operator-only bounded cost reconciliation", () => {
  let directory: string;
  let ledgerPath: string;
  let plan: any;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "hedwig-cost-reconciliation-"));
    ledgerPath = join(directory, "ledger.json");
    budget.initializeBudgetLedger(ledgerPath, originalPlan);
    const ledger = read(ledgerPath);
    ledger.entries = Array.from({ length: 332 }, (_, index) => ({
      id: `old-${index}`,
      planHash: originalPlan.planHash,
      maxTokens: 6144,
      reservedNanoUsd,
      status: "settled",
      costNanoUsd: 1000,
    }));
    ledger.entries.push({
      id: "old-permanent-unknown",
      planHash: originalPlan.planHash,
      maxTokens: 6144,
      reservedNanoUsd,
      status: "uncertain",
      recovery: {
        disposition: "full_reservation_accounted",
        recoveryId: randomUUID(),
        entryId: "old-permanent-unknown",
        previousStatus: "reserved",
        previousLedgerIntegrity: "a".repeat(64),
        lockSha256: "b".repeat(64),
        ownerPid: 12345,
        reservedNanoUsd,
        recoveredAt: "2026-11-12T10:00:00.000Z",
      },
    });
    save(ledgerPath, ledger);
    plan = budget.extendBudgetCap(ledgerPath, originalPlan, {
      authorizationId: randomUUID(),
      approvedAt: new Date().toISOString(),
      approvalReference: "disposable-test-only",
      expectedLedgerIntegrity: read(ledgerPath).integrity,
      approvedTotalNanoUsd: 6e9,
    }).plan;
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  async function uncertain(id?: string) {
    await budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () =>
        new Response(JSON.stringify(id ? { id } : {}), {
          headers: id ? { "X-Generation-Id": id } : undefined,
        }),
    })(endpoint, requestBody);
  }
  function operation(cost: any = 0.02, id = "gen-matched") {
    const ledger = read(ledgerPath),
      entry = ledger.entries.at(-1);
    const now = new Date().toISOString();
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
        data: {
          id,
          model: catalog.id,
          api_type: "completions",
          created_at: entry.requestedAt,
          total_cost: cost,
          usage: cost,
          cancelled: false,
          finish_reason: "stop",
        },
      }),
      attributionJson: JSON.stringify({
        entryId: entry.id,
        generationId: id,
        model: catalog.id,
        method: entry.generationId
          ? "captured_generation_id"
          : "reviewed_unique_match",
        operatorReference: "disposable-test-only/not-real-provider-proof",
        reviewedAt: now,
        uniqueMatchConfirmed: true,
        finalCostConfirmed: true,
        providerResponseSha256: "c".repeat(64),
        matchEvidenceSha256: "d".repeat(64),
      }),
    });
  }

  it("settles only the matched latest entry and preserves all333 prior entries, cap and both histories", async () => {
    await uncertain("gen-matched");
    const before = read(ledgerPath),
      bytes = readFileSync(ledgerPath);
    const op = operation();
    const result = budget.reconcileBudgetEntry(ledgerPath, plan, op);
    const after = read(ledgerPath),
      target = after.entries.at(-1);
    expect(after.entries.slice(0, 333)).to.deep.equal(
      before.entries.slice(0, 333)
    );
    for (const key of [
      "schemaVersion",
      "planHash",
      "capNanoUsd",
      "planHistory",
      "capAuthorizations",
    ])
      expect(after[key]).to.deep.equal(before[key]);
    expect(after.entries).to.have.length(334);
    expect(target).to.include({
      status: "settled",
      costNanoUsd: 20000000,
      generationId: "gen-matched",
      reservedNanoUsd,
    });
    expect(target.reconciliation.originalEntry).to.deep.equal(
      before.entries.at(-1)
    );
    expect(target.reconciliation.receiptJson).to.equal(op.receiptJson);
    expect(target.reconciliation.attributionJson).to.equal(op.attributionJson);
    expect(result.summary).to.include({
      spentUsd: 0.020332,
      reservedUsd: 0.786016,
      recoveredReservedUsd: 0.786016,
      remainingUsd: 5.193652,
      blocked: false,
      requestCount: 334,
    });
    expect(
      readFileSync(join(result.auditDirectory, "ledger.before.json"))
    ).to.deep.equal(bytes);
    expect(
      readFileSync(join(result.auditDirectory, "provider-receipt.json"), "utf8")
    ).to.equal(op.receiptJson);
    expect(
      read(join(result.auditDirectory, "reconciliation.applied.json"))
        .ledgerIntegrity
    ).to.equal(after.integrity);
    expect(existsSync(`${ledgerPath}.lock`)).to.equal(false);
  });

  it("supports explicit unique-match attribution when the prior run captured no generation ID", async () => {
    await uncertain();
    const op = operation();
    const bad = structuredClone(op),
      attribution = JSON.parse(bad.attributionJson);
    attribution.method = "captured_generation_id";
    bad.attributionJson = JSON.stringify(attribution);
    rehash(bad);
    expect(() => budget.reconcileBudgetEntry(ledgerPath, plan, bad)).to.throw(
      "invalid_reconciliation_evidence"
    );
    budget.reconcileBudgetEntry(ledgerPath, plan, op);
    expect(read(ledgerPath).entries.at(-1)).to.include({
      generationId: "gen-matched",
      status: "settled",
    });
  });

  it("rejects duplicate-key or non-normalized JSON before preserving any audit text", async () => {
    await uncertain("gen-matched");
    const before = readFileSync(ledgerPath);
    for (const mutation of [
      (op: any) => {
        op.receiptJson = op.receiptJson.replace(
          '"provider":"openrouter"',
          '"provider":"PRIVATE_CREDENTIAL","provider":"openrouter"'
        );
      },
      (op: any) => {
        op.attributionJson = op.attributionJson.replace(
          '"operatorReference":',
          '"operatorReference":"PRIVATE_DISCARDED_TEXT","operatorReference":'
        );
      },
      (op: any) => {
        op.receiptJson = JSON.stringify(JSON.parse(op.receiptJson), null, 2);
      },
    ]) {
      const op = operation();
      mutation(op);
      rehash(op);
      expect(() => budget.reconcileBudgetEntry(ledgerPath, plan, op)).to.throw(
        "invalid_reconciliation_evidence"
      );
      expect(readFileSync(ledgerPath)).to.deep.equal(before);
      expect(
        readdirSync(directory).filter((name) =>
          name.startsWith("hedwig-budget-reconciliation-")
        )
      ).to.deep.equal([]);
    }
  });

  it("validates the reconciliation on a fresh read after later requests, extension and another reconciliation", async () => {
    await uncertain("gen-matched");
    budget.reconcileBudgetEntry(ledgerPath, plan, operation());
    await budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () =>
        new Response('{"id":"gen-next","usage":{"cost":0.01}}'),
    })(endpoint, requestBody);
    expect(budget.readBudgetSummary(ledgerPath, plan).spentUsd).to.equal(
      0.030332
    );
    plan = budget.extendBudgetCap(ledgerPath, plan, {
      authorizationId: randomUUID(),
      approvedAt: new Date().toISOString(),
      approvalReference: "disposable-followup",
      expectedLedgerIntegrity: read(ledgerPath).integrity,
      approvedTotalNanoUsd: 7e9,
    }).plan;
    await uncertain("gen-second-unknown");
    budget.reconcileBudgetEntry(
      ledgerPath,
      plan,
      operation(0.03, "gen-second-unknown")
    );
    expect(budget.readBudgetSummary(ledgerPath, plan)).to.include({
      spentUsd: 0.060332,
      reservedUsd: 0.786016,
      blocked: false,
      requestCount: 336,
    });
  });

  it("rejects invalid or nonfinal costs, wrong model/operation/identity and unverifiable attribution without changing bytes", async () => {
    expect(budget.reconcileBudgetEntry).to.be.a("function");
    await uncertain("gen-matched");
    const before = readFileSync(ledgerPath);
    const mutations: Array<(receipt: any, attribution: any) => void> = [
      (r) => {
        delete r.data.total_cost;
      },
      (r) => {
        r.data.total_cost = -1;
      },
      (r) => {
        r.data.total_cost = "0.02";
      },
      (r) => {
        r.data.total_cost = null;
      },
      (r) => {
        r.data.total_cost = 1;
      },
      (r) => {
        r.data.usage = 0.03;
      },
      (r) => {
        r.data.upstream_inference_cost = 0.02;
        delete r.data.total_cost;
      },
      (r) => {
        r.httpStatus = 404;
      },
      (r) => {
        r.endpoint = "https://example.invalid/generation";
      },
      (r) => {
        r.data.finish_reason = null;
      },
      (r) => {
        r.data.finish_reason = "pending";
      },
      (r) => {
        r.data.model = "openai/gpt-4.1";
      },
      (r) => {
        r.data.api_type = "embeddings";
      },
      (r) => {
        r.data.id = "gen-other";
      },
      (r) => {
        r.data.created_at = "2001-01-01T00:00:00.000Z";
      },
      (_r, a) => {
        a.uniqueMatchConfirmed = false;
      },
      (_r, a) => {
        a.finalCostConfirmed = false;
      },
      (_r, a) => {
        a.entryId = "other-entry";
      },
      (_r, a) => {
        a.model = "openai/gpt-4.1";
      },
      (_r, a) => {
        a.generationId = "gen-other";
      },
      (_r, a) => {
        a.operatorReference = "";
      },
      (_r, a) => {
        delete a.matchEvidenceSha256;
      },
      (r) => {
        r.authorization = "PRIVATE_CREDENTIAL";
      },
      (r) => {
        r.data.prompt = "PRIVATE_CONTENT";
      },
      (_r, a) => {
        a.private = "PRIVATE_CONTENT";
      },
    ];
    for (const mutate of mutations) {
      const op = operation(),
        receipt = JSON.parse(op.receiptJson),
        attribution = JSON.parse(op.attributionJson);
      mutate(receipt, attribution);
      op.receiptJson = JSON.stringify(receipt);
      op.attributionJson = JSON.stringify(attribution);
      rehash(op);
      expect(() =>
        budget.reconcileBudgetEntry(ledgerPath, plan, op)
      ).to.throw();
      expect(readFileSync(ledgerPath)).to.deep.equal(before);
    }
    for (const change of [
      { expectedReceiptSha256: "0".repeat(64) },
      { expectedAttributionSha256: "0".repeat(64) },
      { expectedLedgerIntegrity: "0".repeat(64) },
      { expectedReservationNanoUsd: 1 },
      { receiptJson: " ".repeat(4097) },
      { attributionJson: " ".repeat(2049) },
    ]) {
      expect(() =>
        budget.reconcileBudgetEntry(ledgerPath, plan, {
          ...operation(),
          ...change,
        })
      ).to.throw();
      expect(readFileSync(ledgerPath)).to.deep.equal(before);
    }
  });

  it("accepts an explicitly finalized zero charge for cancellation or completed generation", async () => {
    await uncertain("gen-matched");
    const op = operation(0),
      receipt = JSON.parse(op.receiptJson);
    receipt.data.cancelled = true;
    receipt.data.finish_reason = null;
    op.receiptJson = JSON.stringify(receipt);
    rehash(op);
    budget.reconcileBudgetEntry(ledgerPath, plan, op);
    expect(read(ledgerPath).entries.at(-1)).to.include({
      status: "settled",
      costNanoUsd: 0,
    });
    expect(budget.readBudgetSummary(ledgerPath, plan).reservedUsd).to.equal(
      0.786016
    );
    await uncertain("gen-zero-completed");
    budget.reconcileBudgetEntry(
      ledgerPath,
      plan,
      operation(0, "gen-zero-completed")
    );
    expect(read(ledgerPath).entries.at(-1)).to.include({
      status: "settled",
      costNanoUsd: 0,
    });
    expect(budget.readBudgetSummary(ledgerPath, plan)).to.include({
      spentUsd: 0.000332,
      reservedUsd: 0.786016,
      blocked: false,
    });
  });

  it("refuses prefix/recovered targets, conflicts, duplicate provider IDs and non-latest uncertain entries", async () => {
    await budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () =>
        new Response('{"id":"gen-matched","usage":{"cost":0.01}}'),
    })(endpoint, requestBody);
    await uncertain("gen-matched");
    let before = readFileSync(ledgerPath);
    expect(() =>
      budget.reconcileBudgetEntry(ledgerPath, plan, operation())
    ).to.throw("duplicate_generation_id");
    expect(readFileSync(ledgerPath)).to.deep.equal(before);
    const duplicate = read(ledgerPath);
    delete duplicate.entries[333].generationId;
    save(ledgerPath, duplicate);
    expect(() =>
      budget.reconcileBudgetEntry(ledgerPath, plan, {
        ...operation(),
        expectedEntryId: "old-permanent-unknown",
      })
    ).to.throw("ineligible_reconciliation");
    const conflict = read(ledgerPath);
    conflict.entries.at(-1).receiptIssue = "generation_id_conflict";
    save(ledgerPath, conflict);
    before = readFileSync(ledgerPath);
    expect(() =>
      budget.reconcileBudgetEntry(ledgerPath, plan, operation())
    ).to.throw("ineligible_reconciliation");
    expect(readFileSync(ledgerPath)).to.deep.equal(before);
    delete conflict.entries.at(-1).receiptIssue;
    const targetId = conflict.entries.at(-1).id;
    conflict.entries.push({
      id: "later-entry",
      planHash: plan.planHash,
      maxTokens: 6144,
      reservedNanoUsd,
      status: "settled",
      costNanoUsd: 0,
    });
    save(ledgerPath, conflict);
    expect(() =>
      budget.reconcileBudgetEntry(ledgerPath, plan, {
        ...operation(),
        expectedEntryId: targetId,
      })
    ).to.throw("ineligible_reconciliation");
  });

  it("refuses repeated reconciliation and detects record tampering despite a recomputed ledger checksum", async () => {
    await uncertain("gen-matched");
    const op = operation();
    budget.reconcileBudgetEntry(ledgerPath, plan, op);
    const good = read(ledgerPath),
      bytes = readFileSync(ledgerPath);
    expect(() => budget.reconcileBudgetEntry(ledgerPath, plan, op)).to.throw();
    expect(readFileSync(ledgerPath)).to.deep.equal(bytes);
    for (const change of [
      (e: any) => {
        e.costNanoUsd = 1;
      },
      (e: any) => {
        e.reconciliation.originalEntry.reservedNanoUsd = 1;
      },
      (e: any) => {
        e.reconciliation.receiptJson = "{}";
      },
      (e: any) => {
        e.reconciliation.previousLedgerIntegrity = "0".repeat(64);
      },
      (e: any) => {
        e.reconciliation.attributionSha256 = "0".repeat(64);
      },
    ]) {
      const bad = structuredClone(good);
      change(bad.entries.at(-1));
      save(ledgerPath, bad);
      expect(() => budget.readBudgetSummary(ledgerPath, plan)).to.throw();
    }
  });

  function interrupt(stage: string, op: any) {
    return spawnSync(
      process.execPath,
      [
        "-e",
        `
      const fs=require('node:fs'),budget=require(process.argv[1]);
      const filename=process.argv[2],stage=process.argv[5];
      const rename=fs.renameSync;
      fs.renameSync=function(from,to){if(to===filename&&stage==='before-commit')process.exit(17);const r=rename.apply(this,arguments);if(to===filename&&stage==='after-commit')process.exit(18);return r;};
      const open=fs.openSync;
      fs.openSync=function(file){if(String(file).endsWith(stage==='audit-failure'?'reconciliation.intent.json':'reconciliation.applied.json')&&['audit-failure','receipt-failure'].includes(stage))throw Error('fixture storage failure');return open.apply(this,arguments);};
      try{budget.reconcileBudgetEntry(filename,JSON.parse(process.argv[3]),JSON.parse(process.argv[4]));process.exit(0);}catch{process.exit(19);}
    `,
        helper,
        ledgerPath,
        JSON.stringify(plan),
        JSON.stringify(op),
        stage,
      ],
      { encoding: "utf8", timeout: 5000 }
    );
  }
  for (const stage of [
    "audit-failure",
    "before-commit",
    "after-commit",
    "receipt-failure",
  ]) {
    it(`retains evidence and safe admission after ${stage}`, async () => {
      await uncertain("gen-matched");
      const before = readFileSync(ledgerPath),
        op = operation();
      const child = interrupt(stage, op);
      expect(child.status, child.stderr).to.equal(
        stage === "before-commit" ? 17 : stage === "after-commit" ? 18 : 19
      );
      const audit = join(
        directory,
        readdirSync(directory).find((name) =>
          name.startsWith("hedwig-budget-reconciliation-")
        )!
      );
      expect(readFileSync(join(audit, "ledger.before.json"))).to.deep.equal(
        before
      );
      expect(existsSync(join(audit, "reconciliation.applied.json"))).to.equal(
        false
      );
      expect(existsSync(`${ledgerPath}.lock`)).to.equal(
        stage !== "audit-failure"
      );
      if (["audit-failure", "before-commit"].includes(stage))
        expect(readFileSync(ledgerPath)).to.deep.equal(before);
      let calls = 0,
        failure: unknown;
      try {
        await budget.installBudgetGuard({
          ledgerPath,
          plan,
          fetch: async () => {
            calls++;
            throw Error("no provider");
          },
        })(endpoint, requestBody);
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).to.contain(
        stage === "audit-failure" ? "unsettled_request" : "ledger_busy"
      );
      expect(calls).to.equal(0);
    });
  }

  it("serializes competing reconciliation processes without releasing another owner's lock", async function () {
    this.timeout(10000);
    await uncertain("gen-matched");
    const op = operation();
    const marker = join(directory, "ready"),
      resume = join(directory, "resume");
    const worker = spawn(
      process.execPath,
      [
        "-e",
        `
      const fs=require('node:fs'),budget=require(process.argv[1]),filename=process.argv[2],marker=process.argv[5],resume=process.argv[6];const rename=fs.renameSync;
      fs.renameSync=function(from,to){if(to===filename){fs.writeFileSync(marker,'ready');const until=Date.now()+5000;while(!fs.existsSync(resume)){if(Date.now()>until)process.exit(21);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}return rename.apply(this,arguments);};
      try{budget.reconcileBudgetEntry(filename,JSON.parse(process.argv[3]),JSON.parse(process.argv[4]));}catch{process.exit(22);}
    `,
        helper,
        ledgerPath,
        JSON.stringify(plan),
        JSON.stringify(op),
        marker,
        resume,
      ],
      { stdio: "ignore" }
    );
    const done = new Promise<number | null>((resolve) =>
      worker.once("exit", resolve)
    );
    try {
      const deadline = Date.now() + 4000;
      while (!existsSync(marker) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(marker)).to.equal(true);
      const owner = readFileSync(`${ledgerPath}.lock`);
      expect(() =>
        budget.reconcileBudgetEntry(ledgerPath, plan, {
          ...op,
          reconciliationId: randomUUID(),
        })
      ).to.throw("ledger_busy");
      expect(readFileSync(`${ledgerPath}.lock`)).to.deep.equal(owner);
      writeFileSync(resume, "go");
      expect(await done).to.equal(0);
      expect(
        read(ledgerPath).entries.filter((e: any) => e.reconciliation)
      ).to.have.length(1);
      expect(budget.readBudgetSummary(ledgerPath, plan).reservedUsd).to.equal(
        0.786016
      );
    } finally {
      if (!existsSync(resume)) writeFileSync(resume, "go");
      await done;
    }
  });
});
