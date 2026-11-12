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
  id: "openai/gpt-4.1-mini",
  context_length: 1047576,
  top_provider: { max_completion_tokens: 32768 },
  pricing: { prompt: "0.0000004", completion: "0.0000016" },
};
const plan = budget.createBudgetPlan(catalog);
const reservedNanoUsd = 422307200;
const request = {
  method: "POST",
  body: JSON.stringify({
    model: catalog.id,
    stream: false,
    temperature: 0,
    max_tokens: 2048,
    provider: {
      require_parameters: true,
      allow_fallbacks: false,
      data_collection: "deny",
      zdr: true,
    },
    messages: [{ role: "user", content: "Public disposable budget fixture." }],
    response_format: { type: "json_schema", json_schema: {} },
  }),
};
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}
function hash(value: any) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function read(filename: string) {
  return JSON.parse(readFileSync(filename, "utf8"));
}
function save(filename: string, value: any) {
  const { integrity: _integrity, ...content } = value;
  writeFileSync(
    filename,
    JSON.stringify({ ...content, integrity: hash(content) })
  );
}
function approval(filename: string, total = 6e9) {
  return {
    authorizationId: randomUUID(),
    approvedAt: "2026-11-12T12:00:00.000Z",
    approvalReference: "disposable-test-only/no-user-authorization",
    expectedLedgerIntegrity: read(filename).integrity,
    approvedTotalNanoUsd: total,
  };
}
function seedHistory(filename: string) {
  const ledger = read(filename);
  ledger.entries = Array.from({ length: 10 }, (_, index) => ({
    id: `settled-${index}`,
    planHash: plan.planHash,
    maxTokens: 2048,
    reservedNanoUsd,
    status: "settled",
    costNanoUsd: 400000000,
  }));
  const unknown = {
    id: "recovered-unknown",
    planHash: plan.planHash,
    maxTokens: 2048,
    reservedNanoUsd,
    status: "uncertain",
    recovery: {
      disposition: "full_reservation_accounted",
      recoveryId: randomUUID(),
      entryId: "recovered-unknown",
      previousStatus: "reserved",
      previousLedgerIntegrity: "a".repeat(64),
      lockSha256: "b".repeat(64),
      ownerPid: 12345,
      reservedNanoUsd,
      recoveredAt: "2026-11-12T11:00:00.000Z",
    },
  };
  ledger.entries.push(unknown);
  save(filename, ledger);
  return read(filename);
}
async function rejects(run: () => Promise<unknown>, code: string) {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  expect(failure).to.be.instanceOf(Error);
  expect((failure as Error).message).to.contain(code);
}

describe("explicit additive evaluation cap extensions", () => {
  let directory: string;
  let ledgerPath: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "hedwig-cap-extension-"));
    ledgerPath = join(directory, "ledger.json");
    budget.initializeBudgetLedger(ledgerPath, plan);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("adds only the approved total-cap difference while preserving every prior entry and recovery", () => {
    const before = seedHistory(ledgerPath);
    const originalBytes = readFileSync(ledgerPath);
    const authorization = approval(ledgerPath);
    const result = budget.extendBudgetCap(ledgerPath, plan, authorization);
    const after = read(ledgerPath);
    expect(after.schemaVersion).to.equal(3);
    expect(after.entries).to.deep.equal(before.entries);
    expect(after.planHistory).to.deep.equal([
      ...before.planHistory,
      result.plan,
    ]);
    expect(after.capAuthorizations).to.have.length(1);
    expect(after.capAuthorizations[0]).to.include({
      authorizationId: authorization.authorizationId,
      previousLedgerIntegrity: before.integrity,
      previousPlanHash: plan.planHash,
      previousCapNanoUsd: 5e9,
      approvedTotalNanoUsd: 6e9,
      entryCount: before.entries.length,
      entryPrefixHash: hash(before.entries),
    });
    expect(result.summary).to.include({
      spentUsd: 4,
      reservedUsd: 0.4223072,
      recoveredReservedUsd: 0.4223072,
      remainingUsd: 1.5776928,
      blocked: false,
      requestCount: 11,
    });
    expect(
      readFileSync(join(result.auditDirectory, "ledger.before.json"))
    ).to.deep.equal(originalBytes);
    expect(
      read(join(result.auditDirectory, "plan.proposed.json"))
    ).to.deep.equal(result.plan);
    expect(
      read(join(result.auditDirectory, "extension.applied.json"))
        .ledgerIntegrity
    ).to.equal(after.integrity);
    expect(existsSync(`${ledgerPath}.lock`)).to.equal(false);
  });

  it("keeps the normal five-dollar constructor and initializer closed to extended plans", () => {
    expect(budget.createBudgetPlan(catalog).capNanoUsd).to.equal(5e9);
    expect(() => budget.createBudgetPlan(catalog, catalog.id, 6)).to.throw(
      "invalid_plan"
    );
    const result = budget.extendBudgetCap(
      ledgerPath,
      plan,
      approval(ledgerPath)
    );
    const empty = join(directory, "empty.json");
    expect(() => budget.initializeBudgetLedger(empty, result.plan)).to.throw(
      "extended_plan_requires_existing_ledger"
    );
    expect(existsSync(empty)).to.equal(false);
    expect(existsSync(`${empty}.lock`)).to.equal(false);
    expect(() => budget.initializeBudgetLedger(ledgerPath, plan)).to.throw(
      "invalid_ledger"
    );
    expect(() =>
      budget.amendBudgetPlan(ledgerPath, result.plan, result.plan)
    ).to.throw("extended_plan_amendment_refused");
  });

  it("requires a validated active existing ledger before fresh-catalog requalification", () => {
    expect(
      budget.qualifyExistingBudgetPlan(ledgerPath, plan, catalog, catalog.id)
    ).to.deep.equal(plan);
    const result = budget.extendBudgetCap(
      ledgerPath,
      plan,
      approval(ledgerPath)
    );
    expect(
      budget.qualifyExistingBudgetPlan(
        ledgerPath,
        result.plan,
        { data: [catalog] },
        catalog.id
      )
    ).to.deep.equal(result.plan);
    const empty = join(directory, "missing.json");
    expect(() =>
      budget.qualifyExistingBudgetPlan(empty, result.plan, catalog, catalog.id)
    ).to.throw("invalid_ledger");
    expect(existsSync(empty)).to.equal(false);
    const independent = join(directory, "independent.json");
    budget.initializeBudgetLedger(independent, plan);
    expect(() =>
      budget.qualifyExistingBudgetPlan(
        independent,
        result.plan,
        catalog,
        catalog.id
      )
    ).to.throw("invalid_ledger");
    expect(() =>
      budget.qualifyExistingBudgetPlan(
        ledgerPath,
        result.plan,
        { ...catalog, context_length: 2000000 },
        catalog.id
      )
    ).to.throw("catalog_plan_changed");
    expect(() =>
      budget.qualifyExistingBudgetPlan(
        ledgerPath,
        result.plan,
        catalog,
        "openai/gpt-4.1"
      )
    ).to.throw();
    expect(() =>
      budget.qualifyExistingBudgetPlan(ledgerPath, plan, catalog, catalog.id)
    ).to.throw("invalid_ledger");
  });

  it("keeps old guards closed and counts old charges plus unknown reserve against all new requests", async () => {
    seedHistory(ledgerPath);
    let calls = 0;
    const fakeFetch = async () => {
      calls++;
      return new Response('{"usage":{"cost":0.4}}');
    };
    const oldGuard = budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: fakeFetch,
    });
    const result = budget.extendBudgetCap(
      ledgerPath,
      plan,
      approval(ledgerPath)
    );
    await rejects(() => oldGuard(endpoint, request), "invalid_ledger");
    expect(calls).to.equal(0);
    const guarded = budget.installBudgetGuard({
      ledgerPath,
      plan: result.plan,
      fetch: fakeFetch,
    });
    for (let index = 0; index < 3; index++) await guarded(endpoint, request);
    await rejects(() => guarded(endpoint, request), "cap_exhausted");
    expect(calls).to.equal(3);
    expect(budget.readBudgetSummary(ledgerPath, result.plan)).to.include({
      spentUsd: 5.2,
      reservedUsd: 0.4223072,
      remainingUsd: 0.3776928,
      requestCount: 14,
    });
    expect(
      read(ledgerPath)
        .entries.slice(11)
        .every((entry: any) => entry.planHash === result.plan.planHash)
    ).to.equal(true);
  });

  it("passes the real runner's catalog preflight only for the linked existing extended ledger", () => {
    const result = budget.extendBudgetCap(
      ledgerPath,
      plan,
      approval(ledgerPath)
    );
    const planPath = join(result.auditDirectory, "plan.proposed.json");
    const preload = join(directory, "public-catalog-preload.js");
    const attemptedUsage = join(directory, "usage-boundary.txt");
    writeFileSync(
      preload,
      `
      const fs = require('node:fs');
      const Module = require('node:module');
      const exists = fs.existsSync;
      fs.existsSync = function(filename) {
        if (/mcp[\\\\/]dist[\\\\/](server|knowledge)\\.js$/.test(String(filename))) return true;
        return exists.call(this, filename);
      };
      const load = Module._load;
      Module._load = function(id, ...args) {
        if (id === './live-eval-evidence') return { captureEvidenceBinding: () => ({ algorithm: 'fixture', files: {} }), evidenceBindingsMatch: () => true, parseProviderDiagnostic: () => undefined };
        return load.call(this, id, ...args);
      };
      globalThis.fetch = async (url) => {
        if (url === 'https://openrouter.ai/api/v1/models') return new Response(${JSON.stringify(
          JSON.stringify({ data: [catalog] })
        )});
        fs.writeFileSync(${JSON.stringify(
          attemptedUsage
        )}, 'local usage boundary reached; no network');
        throw Error('all non-catalog network disabled in disposable test');
      };
    `
    );
    for (const present of [false, true]) {
      const target = present
        ? ledgerPath
        : join(directory, "missing-ledger.json");
      const child = spawnSync(
        process.execPath,
        ["--require", preload, join(__dirname, "foundations-live-eval.js")],
        {
          encoding: "utf8",
          timeout: 5000,
          env: {
            ...process.env,
            OPENROUTER_API_KEY: "public-disposable-fixture",
            HEDWIG_OPENROUTER_MODEL: catalog.id,
            HEDWIG_EVAL_BUDGET_PLAN: planPath,
            HEDWIG_EVAL_BUDGET_LEDGER: target,
            HEDWIG_EVAL_REPORT_PATH: join(directory, `runner-${present}.jsonl`),
            HEDWIG_EVAL_BUDGET_PRELOAD: "0",
          },
        }
      );
      expect(child.status, child.stderr).to.equal(2);
      const report = JSON.parse(child.stdout);
      expect(report.stopReason).to.equal(
        present ? "usage_measurement_unavailable" : "price_qualification_failed"
      );
      expect(report.complete).to.equal(false);
      expect(report.cases).to.deep.equal([]);
      expect(existsSync(attemptedUsage)).to.equal(present);
      expect(existsSync(target)).to.equal(present);
      if (present) expect(report.budgetPlanHash).to.equal(result.plan.planHash);
    }
  });

  it("rejects stale approval state, repeated authorization IDs and unsafe or non-increasing totals", () => {
    const original = readFileSync(ledgerPath);
    for (const total of [
      NaN,
      Infinity,
      -1,
      0,
      5e9,
      4e9,
      6e9 + 0.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        budget.extendBudgetCap(ledgerPath, plan, approval(ledgerPath, total))
      ).to.throw("invalid_extension_request");
      expect(readFileSync(ledgerPath)).to.deep.equal(original);
    }
    expect(() =>
      budget.extendBudgetCap(ledgerPath, plan, {
        ...approval(ledgerPath),
        approvalReference: "",
      })
    ).to.throw("invalid_extension_request");
    expect(() =>
      budget.extendBudgetCap(ledgerPath, plan, {
        ...approval(ledgerPath),
        expectedLedgerIntegrity: "0".repeat(64),
      })
    ).to.throw("extension_state_changed");
    const firstApproval = approval(ledgerPath);
    const first = budget.extendBudgetCap(ledgerPath, plan, firstApproval);
    const after = readFileSync(ledgerPath);
    expect(() =>
      budget.extendBudgetCap(ledgerPath, plan, firstApproval)
    ).to.throw();
    expect(() =>
      budget.extendBudgetCap(ledgerPath, first.plan, {
        ...approval(ledgerPath, 7e9),
        authorizationId: firstApproval.authorizationId,
      })
    ).to.throw("duplicate_authorization");
    expect(readFileSync(ledgerPath)).to.deep.equal(after);
  });

  it("validates multiple extensions and intervening charges without flattening either history", async () => {
    seedHistory(ledgerPath);
    const first = budget.extendBudgetCap(
      ledgerPath,
      plan,
      approval(ledgerPath)
    );
    await budget.installBudgetGuard({
      ledgerPath,
      plan: first.plan,
      fetch: async () => new Response('{"usage":{"cost":0.1}}'),
    })(endpoint, request);
    const intermediate = read(ledgerPath);
    const second = budget.extendBudgetCap(
      ledgerPath,
      first.plan,
      approval(ledgerPath, 7e9)
    );
    const final = read(ledgerPath);
    expect(final.capAuthorizations.slice(0, 1)).to.deep.equal(
      intermediate.capAuthorizations
    );
    expect(final.planHistory).to.deep.equal([
      ...intermediate.planHistory,
      second.plan,
    ]);
    expect(final.entries).to.deep.equal(intermediate.entries);
    expect(
      budget.readBudgetSummary(ledgerPath, second.plan).remainingUsd
    ).to.equal(2.4776928);
    expect(() => budget.readBudgetSummary(ledgerPath, first.plan)).to.throw(
      "invalid_ledger"
    );
  });

  it("retains prior same-cap model amendments with their original plans and charges", async () => {
    const nextCatalog = { ...catalog, id: "openai/gpt-4.1" };
    const nextPlan = budget.createBudgetPlan(nextCatalog, nextCatalog.id);
    const fakeFetch = async () => new Response('{"usage":{"cost":0.1}}');
    await budget.installBudgetGuard({ ledgerPath, plan, fetch: fakeFetch })(
      endpoint,
      request
    );
    budget.amendBudgetPlan(ledgerPath, plan, nextPlan);
    await budget.installBudgetGuard({
      ledgerPath,
      plan: nextPlan,
      fetch: fakeFetch,
    })(endpoint, {
      ...request,
      body: JSON.stringify({
        ...JSON.parse(request.body),
        model: nextCatalog.id,
      }),
    });
    const before = read(ledgerPath);
    const result = budget.extendBudgetCap(
      ledgerPath,
      nextPlan,
      approval(ledgerPath)
    );
    expect(read(ledgerPath).planHistory).to.deep.equal([
      plan,
      nextPlan,
      result.plan,
    ]);
    expect(read(ledgerPath).entries).to.deep.equal(before.entries);
    expect(
      budget.qualifyExistingBudgetPlan(
        ledgerPath,
        result.plan,
        nextCatalog,
        nextCatalog.id
      )
    ).to.deep.equal(result.plan);
    expect(result.summary).to.include({ spentUsd: 0.2, remainingUsd: 5.8 });
  });

  it("refuses unrecovered uncertainty and preserves another writer's lock", () => {
    const before = seedHistory(ledgerPath);
    delete before.entries[10].recovery;
    save(ledgerPath, before);
    const bytes = readFileSync(ledgerPath);
    expect(() =>
      budget.extendBudgetCap(ledgerPath, plan, approval(ledgerPath))
    ).to.throw("unsettled_request");
    expect(readFileSync(ledgerPath)).to.deep.equal(bytes);
    writeFileSync(`${ledgerPath}.lock`, "another owner");
    expect(() =>
      budget.extendBudgetCap(ledgerPath, plan, approval(ledgerPath))
    ).to.throw("ledger_busy");
    expect(readFileSync(`${ledgerPath}.lock`, "utf8")).to.equal(
      "another owner"
    );
  });

  it("rejects recomputed checksums after dropping history, reserves, authorization links or prior charges", () => {
    seedHistory(ledgerPath);
    const first = budget.extendBudgetCap(
      ledgerPath,
      plan,
      approval(ledgerPath)
    );
    const second = budget.extendBudgetCap(
      ledgerPath,
      first.plan,
      approval(ledgerPath, 7e9)
    );
    const good = read(ledgerPath);
    const mutations = [
      (v: any) => v.entries.splice(0, 1),
      (v: any) => {
        v.entries[0].costNanoUsd = 1;
      },
      (v: any) => {
        delete v.entries[10].recovery;
      },
      (v: any) => v.planHistory.reverse(),
      (v: any) => v.capAuthorizations.reverse(),
      (v: any) => {
        v.capAuthorizations[0].approvedTotalNanoUsd = 8e9;
      },
      (v: any) => {
        v.capAuthorizations[0].previousLedgerIntegrity = "0".repeat(64);
      },
      (v: any) => {
        v.planHistory[0].catalogPricing.prompt = "0.00001";
      },
      (v: any) => {
        delete v.capAuthorizations;
      },
      (v: any) => {
        v.schemaVersion = 2;
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(good);
      mutate(changed);
      save(ledgerPath, changed);
      expect(() =>
        budget.readBudgetSummary(ledgerPath, second.plan)
      ).to.throw();
    }
    save(ledgerPath, good);
    expect(
      budget.readBudgetSummary(ledgerPath, second.plan).requestCount
    ).to.equal(11);
  });

  function child(stage: string) {
    return spawnSync(
      process.execPath,
      [
        "-e",
        `
      const fs = require('node:fs');
      const budget = require(process.argv[1]);
      const filename = process.argv[2], plan = JSON.parse(process.argv[3]), approval = JSON.parse(process.argv[4]);
      const stage = process.argv[5];
      const rename = fs.renameSync;
      fs.renameSync = function(from, to) {
        if (to === filename && stage === 'before-commit') process.exit(17);
        const result = rename.apply(this, arguments);
        if (to === filename && stage === 'after-commit') process.exit(18);
        return result;
      };
      const open = fs.openSync;
      fs.openSync = function(file) {
        if (String(file).endsWith(stage === 'audit-failure' ? 'extension.intent.json' : 'extension.applied.json') && ['audit-failure','receipt-failure'].includes(stage)) throw Error('disposable storage failure');
        return open.apply(this, arguments);
      };
      try { budget.extendBudgetCap(filename, plan, approval); process.exit(0); }
      catch { process.exit(19); }
    `,
        helper,
        ledgerPath,
        JSON.stringify(plan),
        JSON.stringify(approval(ledgerPath)),
        stage,
      ],
      { encoding: "utf8" }
    );
  }

  it("leaves the original ledger and allowance unchanged when a required pre-commit audit write fails", () => {
    const before = readFileSync(ledgerPath);
    const outcome = child("audit-failure");
    expect(outcome.status, outcome.stderr).to.equal(19);
    expect(readFileSync(ledgerPath)).to.deep.equal(before);
    expect(existsSync(`${ledgerPath}.lock`)).to.equal(false);
    const audit = join(
      directory,
      readdirSync(directory).find((name) =>
        name.startsWith("hedwig-budget-extension-")
      )!
    );
    expect(readFileSync(join(audit, "ledger.before.json"))).to.deep.equal(
      before
    );
    expect(existsSync(join(audit, "plan.proposed.json"))).to.equal(true);
    expect(existsSync(join(audit, "extension.intent.json"))).to.equal(false);
  });

  for (const stage of ["before-commit", "after-commit", "receipt-failure"]) {
    it(`fails closed after interruption at ${stage}, retaining audit evidence and the spending lock`, async () => {
      const before = readFileSync(ledgerPath);
      const outcome = child(stage);
      expect(outcome.status, outcome.stderr).to.equal(
        stage === "before-commit" ? 17 : stage === "after-commit" ? 18 : 19
      );
      expect(existsSync(`${ledgerPath}.lock`)).to.equal(true);
      const audit = join(
        directory,
        readdirSync(directory).find((name) =>
          name.startsWith("hedwig-budget-extension-")
        )!
      );
      expect(readFileSync(join(audit, "ledger.before.json"))).to.deep.equal(
        before
      );
      expect(existsSync(join(audit, "extension.applied.json"))).to.equal(false);
      const activePlan =
        stage === "before-commit"
          ? plan
          : read(join(audit, "plan.proposed.json"));
      let calls = 0;
      const guarded = budget.installBudgetGuard({
        ledgerPath,
        plan: activePlan,
        fetch: async () => {
          calls++;
          throw Error("must never call");
        },
      });
      await rejects(() => guarded(endpoint, request), "ledger_busy");
      expect(calls).to.equal(0);
      if (stage === "before-commit")
        expect(readFileSync(ledgerPath)).to.deep.equal(before);
      else expect(read(ledgerPath).capNanoUsd).to.equal(6e9);
    });
  }

  it("serializes independent extension processes so a contender cannot append or remove the winner's lock", async function () {
    this.timeout(10000);
    const marker = join(directory, "ready");
    const resume = join(directory, "resume");
    const expected = approval(ledgerPath);
    const worker = spawn(
      process.execPath,
      [
        "-e",
        `
      const fs = require('node:fs'); const budget = require(process.argv[1]);
      const filename = process.argv[2], marker = process.argv[5], resume = process.argv[6];
      const rename = fs.renameSync;
      fs.renameSync = function(from, to) {
        if (to === filename) {
          fs.writeFileSync(marker, 'ready');
          const until = Date.now() + 5000;
          while (!fs.existsSync(resume)) { if (Date.now() > until) process.exit(21); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
        }
        return rename.apply(this, arguments);
      };
      try { budget.extendBudgetCap(filename, JSON.parse(process.argv[3]), JSON.parse(process.argv[4])); } catch { process.exit(22); }
    `,
        helper,
        ledgerPath,
        JSON.stringify(plan),
        JSON.stringify(expected),
        marker,
        resume,
      ],
      { stdio: "ignore" }
    );
    const completion = new Promise<number | null>((resolve) =>
      worker.once("exit", resolve)
    );
    try {
      const deadline = Date.now() + 4000;
      while (!existsSync(marker) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(marker)).to.equal(true);
      const owner = readFileSync(`${ledgerPath}.lock`);
      expect(() =>
        budget.extendBudgetCap(ledgerPath, plan, approval(ledgerPath))
      ).to.throw("ledger_busy");
      expect(readFileSync(`${ledgerPath}.lock`)).to.deep.equal(owner);
      writeFileSync(resume, "resume");
      expect(await completion).to.equal(0);
      expect(read(ledgerPath).capAuthorizations).to.have.length(1);
      expect(read(ledgerPath).capNanoUsd).to.equal(6e9);
      expect(existsSync(`${ledgerPath}.lock`)).to.equal(false);
    } finally {
      if (!existsSync(resume)) writeFileSync(resume, "resume");
      await completion;
    }
  });
});
