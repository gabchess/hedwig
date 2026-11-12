import { expect } from "chai";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createOpenRouterFoundationGenerator } from "../src/openrouter";
const budget = require("./live-eval-budget.js");
const helper = resolve(__dirname, "live-eval-budget.js");
const endpoint = "https://openrouter.ai/api/v1/chat/completions";
const original = {
  id: "openai/gpt-5.2",
  context_length: 400000,
  top_provider: { max_completion_tokens: 128000 },
  pricing: { prompt: "0.00000175", completion: "0.000014" },
};
const alternative = {
  id: "qwen/qwen3-235b-a22b-2507",
  context_length: 262144,
  top_provider: { max_completion_tokens: 117964 },
  pricing: {
    prompt: "0.00000014",
    completion: "0.0000008",
    input_cache_read: "0.00000005",
  },
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
function read(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}
function save(file: string, value: any) {
  const { integrity: ignored, ...content } = value;
  writeFileSync(file, JSON.stringify({ ...content, integrity: hash(content) }));
}
function selection(file: string, model = alternative.id) {
  return {
    amendmentId: randomUUID(),
    amendedAt: "2026-11-12T20:00:00.000Z",
    approvalReference: "disposable-test-only/model-selection",
    expectedLedgerIntegrity: read(file).integrity,
    model,
  };
}
function authorization(file: string, total: number) {
  return {
    authorizationId: randomUUID(),
    approvedAt: "2026-11-12T19:00:00.000Z",
    approvalReference: "disposable-test-only/cap-extension",
    expectedLedgerIntegrity: read(file).integrity,
    approvedTotalNanoUsd: total,
  };
}
function request(model: string) {
  return {
    method: "POST",
    body: JSON.stringify({
      model,
      stream: false,
      ...(model === original.id
        ? { reasoning: { effort: "medium", exclude: true }, max_tokens: 6144 }
        : { temperature: 0, max_tokens: 2048 }),
      provider: {
        ...(model === alternative.id ? { sort: "throughput" } : {}),
        require_parameters: true,
        data_collection: "deny",
        allow_fallbacks: false,
        zdr: true,
      },
      messages: [{ role: "user", content: "Public fixture." }],
      response_format: { type: "json_schema", json_schema: {} },
    }),
  };
}
function reconciliation(file: string, model: string, generationId: string) {
  const ledger = read(file),
    entry = ledger.entries.at(-1),
    now = new Date().toISOString();
  const receiptJson = JSON.stringify({
    schemaVersion: 1,
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/generation",
    httpStatus: 200,
    retrievedAt: now,
    data: {
      id: generationId,
      model,
      api_type: "completions",
      created_at: entry.requestedAt,
      total_cost: 0.002,
      usage: 0.002,
      cancelled: false,
      finish_reason: "stop",
    },
  });
  const attributionJson = JSON.stringify({
    entryId: entry.id,
    generationId,
    model,
    method: "captured_generation_id",
    operatorReference: "disposable-test-only/not-real-provider-proof",
    reviewedAt: now,
    uniqueMatchConfirmed: true,
    finalCostConfirmed: true,
    providerResponseSha256: "c".repeat(64),
    matchEvidenceSha256: "d".repeat(64),
  });
  const rawHash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  return {
    reconciliationId: randomUUID(),
    expectedLedgerIntegrity: ledger.integrity,
    expectedEntryId: entry.id,
    expectedReservationNanoUsd: entry.reservedNanoUsd,
    receiptJson,
    expectedReceiptSha256: rawHash(receiptJson),
    attributionJson,
    expectedAttributionSha256: rawHash(attributionJson),
  };
}
async function rejects(run: () => Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  expect(error).to.be.instanceOf(Error);
  expect((error as Error).message).to.contain(code);
}
describe("same-cap evaluation model amendments", () => {
  let directory: string, ledgerPath: string, oldPlan: any;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "hedwig-model-amendment-"));
    ledgerPath = join(directory, "ledger.json");
    const initial = budget.createBudgetPlan(original, original.id);
    budget.initializeBudgetLedger(ledgerPath, initial);
    const ledger = read(ledgerPath);
    ledger.entries = [
      {
        id: "earlier-settled",
        planHash: initial.planHash,
        maxTokens: 6144,
        reservedNanoUsd: 786016000,
        status: "settled",
        costNanoUsd: 200000000,
      },
      {
        id: "earlier-unknown",
        planHash: initial.planHash,
        maxTokens: 6144,
        reservedNanoUsd: 786016000,
        status: "uncertain",
        recovery: {
          disposition: "full_reservation_accounted",
          recoveryId: randomUUID(),
          entryId: "earlier-unknown",
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
    oldPlan = budget.extendBudgetCap(
      ledgerPath,
      initial,
      authorization(ledgerPath, 6e9)
    ).plan;
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  it("qualifies only the exact alternative without relaxing billing fields", () => {
    const plan = budget.createBudgetPlan(alternative, alternative.id);
    expect(plan.maxPrice).to.deep.equal({
      prompt: 0.14,
      completion: 0.8,
      request: 0,
      image: 0,
    });
    for (const model of [
      alternative.id + ":free",
      "qwen/qwen3-235b-a22b",
      "qwen/other",
    ])
      expect(() =>
        budget.createBudgetPlan({ ...alternative, id: model }, model)
      ).to.throw("invalid_plan");
    expect(() =>
      budget.createBudgetPlan(
        {
          ...alternative,
          pricing: { ...alternative.pricing, input_cache_write: "0.0000002" },
        },
        alternative.id
      )
    ).to.throw("unsupported_billing");
  });
  it("prepares without writes and preserves cap, every entry and its authorization on apply", () => {
    const before = read(ledgerPath),
      bytes = readFileSync(ledgerPath),
      names = readdirSync(directory).sort(),
      chosen = selection(ledgerPath);
    const prepared = budget.prepareBudgetModelAmendment(
      ledgerPath,
      oldPlan,
      alternative,
      chosen
    );
    expect(readFileSync(ledgerPath)).to.deep.equal(bytes);
    expect(readdirSync(directory).sort()).to.deep.equal(names);
    expect(prepared.plan).to.include({
      schemaVersion: 3,
      model: alternative.id,
      capNanoUsd: 6e9,
      previousPlanHash: oldPlan.planHash,
      capAuthorizationHash: oldPlan.capAuthorizationHash,
    });
    const applied = budget.applyBudgetModelAmendment(
        ledgerPath,
        oldPlan,
        alternative,
        chosen
      ),
      after = read(ledgerPath);
    expect(applied.plan).to.deep.equal(prepared.plan);
    expect(after.schemaVersion).to.equal(4);
    expect(after.entries).to.deep.equal(before.entries);
    expect(after.capAuthorizations).to.deep.equal(before.capAuthorizations);
    expect(after.planHistory).to.deep.equal([
      ...before.planHistory,
      applied.plan,
    ]);
    expect(after.modelAmendments).to.deep.equal([prepared.amendment]);
    expect(after.capNanoUsd).to.equal(before.capNanoUsd);
    expect(applied.summary).to.include({
      spentUsd: 0.2,
      reservedUsd: 0.786016,
      recoveredReservedUsd: 0.786016,
      remainingUsd: 5.013984,
      requestCount: 2,
      blocked: false,
    });
    expect(
      readFileSync(join(applied.auditDirectory, "ledger.before.json"))
    ).to.deep.equal(bytes);
    expect(
      read(join(applied.auditDirectory, "model-amendment.applied.json"))
        .ledgerIntegrity
    ).to.equal(after.integrity);
    expect(existsSync(ledgerPath + ".lock")).to.equal(false);
    expect(() =>
      budget.initializeBudgetLedger(join(directory, "new.json"), applied.plan)
    ).to.throw("extended_plan_requires_existing_ledger");
    expect(() =>
      budget.applyBudgetModelAmendment(ledgerPath, oldPlan, alternative, chosen)
    ).to.throw();
  });
  it("reserves the whole alternative request and preserves standard generation, privacy and schemas", async () => {
    const changed = budget.applyBudgetModelAmendment(
      ledgerPath,
      oldPlan,
      alternative,
      selection(ledgerPath)
    );
    let calls = 0;
    const guard = budget.installBudgetGuard({
      ledgerPath,
      plan: changed.plan,
      fetch: async (_url: unknown, init: RequestInit) => {
        calls++;
        const sent = JSON.parse(init.body as string);
        expect(sent.model).to.equal(alternative.id);
        expect(sent.max_tokens).to.equal(2048);
        expect(sent.temperature).to.equal(0);
        expect(sent).not.to.have.property("reasoning");
        expect(sent.provider).to.deep.equal({
          data_collection: "deny",
          require_parameters: true,
          allow_fallbacks: false,
          zdr: true,
          sort: "throughput",
          max_price: changed.plan.maxPrice,
        });
        expect(sent.response_format.json_schema.strict).to.equal(true);
        expect(
          budget.readBudgetSummary(ledgerPath, changed.plan).reservedUsd
        ).to.equal(0.82435456);
        return new Response(
          JSON.stringify({
            usage: { cost: 0.001 },
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    answer: "",
                    citationIds: [],
                    unsupportedParts: ["No fixture evidence."],
                  }),
                },
              },
            ],
          })
        );
      },
    });
    await createOpenRouterFoundationGenerator({
      apiKey: "fixture",
      model: alternative.id,
      fetch: guard,
    })({ question: "Public fixture.", sources: [] });
    expect(calls).to.equal(1);
    expect(budget.readBudgetSummary(ledgerPath, changed.plan)).to.include({
      spentUsd: 0.201,
      reservedUsd: 0.786016,
      requestCount: 3,
    });
  });
  it("admits only the bounded Qwen throughput policy before reserving or fetching", async () => {
    const changed = budget.applyBudgetModelAmendment(
      ledgerPath,
      oldPlan,
      alternative,
      selection(ledgerPath)
    );
    let calls = 0;
    const guard = budget.installBudgetGuard({
      ledgerPath,
      plan: changed.plan,
      fetch: async () => {
        calls++;
        return new Response(JSON.stringify({ usage: { cost: 0 } }));
      },
    });
    const good = JSON.parse(request(alternative.id).body),
      before = readFileSync(ledgerPath);
    const changes: Array<(body: any) => void> = [
      (b) => {
        delete b.provider.sort;
      },
      (b) => {
        b.provider.sort = "price";
      },
      (b) => {
        b.provider.sort = { by: "throughput" };
      },
      (b) => {
        b.provider.order = ["parasail"];
      },
      (b) => {
        b.provider.allow_fallbacks = true;
      },
      (b) => {
        b.provider.zdr = false;
      },
      (b) => {
        b.provider.data_collection = "allow";
      },
      (b) => {
        b.provider.require_parameters = false;
      },
      (b) => {
        b.max_tokens = 2049;
      },
      (b) => {
        b.max_tokens = 1025;
      },
      (b) => {
        delete b.temperature;
      },
      (b) => {
        b.reasoning = { effort: "low" };
      },
      (b) => {
        b.provider.max_price = { ...changed.plan.maxPrice, prompt: 1 };
      },
    ];
    for (const change of changes) {
      const body = structuredClone(good);
      change(body);
      await rejects(
        () => guard(endpoint, { method: "POST", body: JSON.stringify(body) }),
        "request_rejected"
      );
      expect(readFileSync(ledgerPath)).to.deep.equal(before);
    }
    expect(calls).to.equal(0);
    for (const max_tokens of [1024, 2048])
      await guard(endpoint, {
        method: "POST",
        body: JSON.stringify({ ...good, max_tokens }),
      });
    expect(calls).to.equal(2);
    expect(
      read(ledgerPath)
        .entries.slice(-2)
        .map((entry: any) => entry.reservedNanoUsd)
    ).to.deep.equal([37519360, 38338560]);
  });
  it("keeps the Qwen receipt deadline aligned and reserves the full charge on timeout", () => {
    const changed = budget.applyBudgetModelAmendment(
      ledgerPath,
      oldPlan,
      alternative,
      selection(ledgerPath)
    );
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        [
          "const b=require(process.argv[1]),set=globalThis.setTimeout;let configured;",
          "globalThis.setTimeout=(callback,delay,...args)=>{if(delay===15000||delay===45000){configured=delay;return set(callback,5,...args);}return set(callback,delay,...args);};",
          "const response=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}),{headers:{'X-Generation-Id':'gen-qwen-receipt-timeout'}});",
          "b.installBudgetGuard({ledgerPath:process.argv[2],plan:JSON.parse(process.argv[3]),fetch:async()=>response})(process.argv[4],JSON.parse(process.argv[5])).then(()=>process.exit(configured===45000?0:2),()=>process.exit(3));",
        ].join("\n"),
        helper,
        ledgerPath,
        JSON.stringify(changed.plan),
        endpoint,
        JSON.stringify(request(alternative.id)),
      ],
      { encoding: "utf8", timeout: 5000 }
    );
    expect(child.status, child.stderr).to.equal(0);
    expect(read(ledgerPath).entries.at(-1)).to.include({
      status: "uncertain",
      generationId: "gen-qwen-receipt-timeout",
      reservedNanoUsd: 38338560,
    });
    expect(budget.readBudgetSummary(ledgerPath, changed.plan)).to.include({
      blocked: true,
      reservedUsd: 0.82435456,
    });
  });
  it("supports model then cap then model without reactivating any earlier guard", async () => {
    let calls = 0;
    const install = (plan: any) =>
      budget.installBudgetGuard({
        ledgerPath,
        plan,
        fetch: async () => {
          calls++;
          return new Response();
        },
      });
    const firstGuard = install(oldPlan);
    const next = budget.applyBudgetModelAmendment(
      ledgerPath,
      oldPlan,
      alternative,
      selection(ledgerPath)
    );
    const secondGuard = install(next.plan);
    await budget.installBudgetGuard({
      ledgerPath,
      plan: next.plan,
      fetch: async () =>
        new Response(JSON.stringify({ usage: { cost: 0.001 } })),
    })(endpoint, request(next.plan.model));
    const alternativeEntry = read(ledgerPath).entries.at(-1);
    expect(alternativeEntry).to.include({
      planHash: next.plan.planHash,
      reservedNanoUsd: 38338560,
      costNanoUsd: 1000000,
    });
    const extended = budget.extendBudgetCap(
      ledgerPath,
      next.plan,
      authorization(ledgerPath, 7e9)
    );
    const thirdGuard = install(extended.plan);
    expect(extended.plan.schemaVersion).to.equal(2);
    expect(extended.plan).not.to.have.property("modelAmendmentHash");
    const returned = budget.applyBudgetModelAmendment(
      ledgerPath,
      extended.plan,
      original,
      selection(ledgerPath, original.id)
    );
    expect(returned.plan.planHash).not.to.equal(oldPlan.planHash);
    expect(returned.plan.capNanoUsd).to.equal(7e9);
    for (const [previous, guard] of [
      [oldPlan, firstGuard],
      [next.plan, secondGuard],
      [extended.plan, thirdGuard],
    ]) {
      await rejects(
        () => guard(endpoint, request(previous.model)),
        "invalid_ledger"
      );
      expect(() => install(previous)).to.throw("invalid_ledger");
    }
    expect(calls).to.equal(0);
    expect(
      budget.readBudgetSummary(ledgerPath, returned.plan).reservedUsd
    ).to.equal(0.786016);
    expect(read(ledgerPath).entries.at(-1)).to.deep.equal(alternativeEntry);
    expect(
      budget.readBudgetSummary(ledgerPath, returned.plan).spentUsd
    ).to.equal(0.201);
    expect(
      budget.qualifyExistingBudgetPlan(
        ledgerPath,
        returned.plan,
        original,
        original.id
      )
    ).to.deep.equal(returned.plan);
  });
  it("refuses stale preparation, cap inputs and unquarantined uncertainty", () => {
    const before = readFileSync(ledgerPath),
      chosen = selection(ledgerPath);
    for (const altered of [
      { ...chosen, expectedLedgerIntegrity: "f".repeat(64) },
      { ...chosen, capNanoUsd: 7e9 },
      { ...chosen, approvedTotalNanoUsd: 7e9 },
      { ...chosen, amendmentId: "invalid" },
      { ...chosen, model: oldPlan.model },
    ]) {
      expect(() =>
        budget.prepareBudgetModelAmendment(
          ledgerPath,
          oldPlan,
          alternative,
          altered
        )
      ).to.throw();
      expect(readFileSync(ledgerPath)).to.deep.equal(before);
    }
    const ledger = read(ledgerPath);
    ledger.entries.push({
      id: "new-unknown",
      planHash: oldPlan.planHash,
      maxTokens: 6144,
      reservedNanoUsd: 786016000,
      status: "uncertain",
    });
    save(ledgerPath, ledger);
    expect(() =>
      budget.prepareBudgetModelAmendment(
        ledgerPath,
        oldPlan,
        alternative,
        selection(ledgerPath)
      )
    ).to.throw("unsettled_request");
  });
  it("rejects changed prefixes, reserves, authority and transition history despite a recomputed outer checksum", () => {
    const next = budget.applyBudgetModelAmendment(
        ledgerPath,
        oldPlan,
        alternative,
        selection(ledgerPath)
      ),
      good = readFileSync(ledgerPath);
    const changes: Array<(ledger: any) => void> = [
      (l) => {
        l.entries[0].costNanoUsd--;
      },
      (l) => {
        l.entries.shift();
      },
      (l) => {
        l.entries[1].reservedNanoUsd--;
      },
      (l) => {
        l.capNanoUsd++;
      },
      (l) => {
        l.capAuthorizations[0].approvedTotalNanoUsd++;
      },
      (l) => {
        l.modelAmendments[0].entryPrefixHash = "f".repeat(64);
      },
      (l) => {
        l.modelAmendments[0].previousLedgerIntegrity = "f".repeat(64);
      },
      (l) => {
        l.modelAmendments[0].model = original.id;
      },
      (l) => {
        l.modelAmendments.push(l.modelAmendments[0]);
      },
      (l) => {
        l.planHistory.at(-1).capAuthorizationHash = "f".repeat(64);
      },
    ];
    for (const corrupt of changes) {
      const l = JSON.parse(good.toString("utf8"));
      corrupt(l);
      save(ledgerPath, l);
      expect(() => budget.readBudgetSummary(ledgerPath, next.plan)).to.throw();
    }
    writeFileSync(ledgerPath, good);
    expect(
      budget.readBudgetSummary(ledgerPath, next.plan).reservedUsd
    ).to.equal(0.786016);
  });
  it("refuses a concurrent owner without changing its lock or ledger", () => {
    const before = readFileSync(ledgerPath),
      chosen = selection(ledgerPath);
    writeFileSync(ledgerPath + ".lock", "another owner", { flag: "wx" });
    expect(() =>
      budget.applyBudgetModelAmendment(ledgerPath, oldPlan, alternative, chosen)
    ).to.throw("ledger_busy");
    expect(readFileSync(ledgerPath)).to.deep.equal(before);
    expect(readFileSync(ledgerPath + ".lock", "utf8")).to.equal(
      "another owner"
    );
  });
  it("preserves header-three reconciliation and binds new header-four reconciliation through later transitions and a fresh process", async () => {
    const uncertain = async (plan: any, generationId: string) =>
      budget.installBudgetGuard({
        ledgerPath,
        plan,
        fetch: async () => new Response(JSON.stringify({ id: generationId })),
      })(endpoint, request(plan.model));
    await uncertain(oldPlan, "gen-original-disposable");
    budget.reconcileBudgetEntry(
      ledgerPath,
      oldPlan,
      reconciliation(ledgerPath, oldPlan.model, "gen-original-disposable")
    );
    const historicalEntry = read(ledgerPath).entries.at(-1),
      historicalBytes = JSON.stringify(historicalEntry);
    expect(
      historicalEntry.reconciliation.previousLedgerHeader.schemaVersion
    ).to.equal(3);
    expect(
      historicalEntry.reconciliation.previousLedgerHeader
    ).not.to.have.property("modelAmendments");
    const changed = budget.applyBudgetModelAmendment(
      ledgerPath,
      oldPlan,
      alternative,
      selection(ledgerPath)
    );
    expect(JSON.stringify(read(ledgerPath).entries[2])).to.equal(
      historicalBytes
    );
    await uncertain(changed.plan, "gen-alternative-disposable");
    budget.reconcileBudgetEntry(
      ledgerPath,
      changed.plan,
      reconciliation(
        ledgerPath,
        changed.plan.model,
        "gen-alternative-disposable"
      )
    );
    const reconciled = read(ledgerPath),
      recent = reconciled.entries.at(-1).reconciliation;
    expect(recent.previousLedgerHeader.schemaVersion).to.equal(4);
    expect(recent.previousLedgerHeader.modelAmendments).to.deep.equal(
      reconciled.modelAmendments
    );
    expect(recent.immutablePrefixCount).to.equal(3);
    const returned = budget.applyBudgetModelAmendment(
      ledgerPath,
      changed.plan,
      original,
      selection(ledgerPath, original.id)
    );
    expect(read(ledgerPath).entries).to.deep.equal(reconciled.entries);
    const fresh = spawnSync(
      process.execPath,
      [
        "-e",
        "const b=require(process.argv[1]),p=JSON.parse(process.argv[3]);b.qualifyExistingBudgetPlan(process.argv[2],p,JSON.parse(process.argv[4]),p.model);process.stdout.write(JSON.stringify(b.readBudgetSummary(process.argv[2],p)));",
        helper,
        ledgerPath,
        JSON.stringify(returned.plan),
        JSON.stringify(original),
      ],
      { encoding: "utf8" }
    );
    expect(fresh.status, fresh.stderr).to.equal(0);
    expect(JSON.parse(fresh.stdout)).to.include({
      spentUsd: 0.204,
      reservedUsd: 0.786016,
      requestCount: 4,
    });
    const good = readFileSync(ledgerPath),
      invalid = read(ledgerPath);
    delete invalid.entries[3].reconciliation.previousLedgerHeader
      .modelAmendments;
    save(ledgerPath, invalid);
    expect(() =>
      budget.readBudgetSummary(ledgerPath, returned.plan)
    ).to.throw();
    writeFileSync(ledgerPath, good);
  });
  it("refuses a stale prepared proposal after an intervening request without losing the charge", async () => {
    const chosen = selection(ledgerPath);
    budget.prepareBudgetModelAmendment(
      ledgerPath,
      oldPlan,
      alternative,
      chosen
    );
    await budget.installBudgetGuard({
      ledgerPath,
      plan: oldPlan,
      fetch: async () =>
        new Response(JSON.stringify({ usage: { cost: 0.01 } })),
    })(endpoint, request(oldPlan.model));
    const before = readFileSync(ledgerPath);
    expect(() =>
      budget.applyBudgetModelAmendment(ledgerPath, oldPlan, alternative, chosen)
    ).to.throw("amendment_state_changed");
    expect(readFileSync(ledgerPath)).to.deep.equal(before);
    expect(budget.readBudgetSummary(ledgerPath, oldPlan).spentUsd).to.equal(
      0.21
    );
    expect(existsSync(ledgerPath + ".lock")).to.equal(false);
  });
  function fault(stage: string, chosen: any) {
    return spawnSync(
      process.execPath,
      [
        "-e",
        [
          "const fs=require('node:fs'),b=require(process.argv[1]),filename=process.argv[2],stage=process.argv[6];",
          "const open=fs.openSync,rename=fs.renameSync,sync=fs.fsyncSync,close=fs.closeSync;let published=false,nextFd=1000000;const files=new Map(),virtual=new Set(),nativePlatform=process.platform;",
          // On Windows virtual directory handles test POSIX error ordering only; they do not prove Windows power-loss durability.
          "if(stage==='directory-sync-failure')Object.defineProperty(process,'platform',{value:'linux'});",
          "fs.openSync=function(file,flags){if(stage==='audit-failure'&&String(file).endsWith('model-amendment.intent.json'))throw Error('fixture audit failure');if(stage==='receipt-failure'&&String(file).endsWith('model-amendment.applied.json'))throw Error('fixture receipt failure');const isVirtual=stage==='directory-sync-failure'&&nativePlatform==='win32'&&flags==='r'&&fs.statSync(file).isDirectory();const fd=isVirtual?nextFd++:open.apply(this,arguments);if(isVirtual)virtual.add(fd);files.set(fd,String(file));return fd;};",
          "fs.closeSync=function(fd){files.delete(fd);if(virtual.delete(fd))return;return close.apply(this,arguments);};",
          "fs.fsyncSync=function(fd){if(stage==='file-sync-failure'&&files.get(fd)?.startsWith(filename+'.')&&!files.get(fd)?.endsWith('.lock'))throw Error('fixture file sync failure');if(stage==='directory-sync-failure'&&published&&files.get(fd)===require('node:path').dirname(filename))throw Error('fixture parent sync failure');if(!virtual.has(fd))return sync.apply(this,arguments);};",
          "fs.renameSync=function(from,to){if(to===filename&&stage==='before-commit')process.exit(17);const value=rename.apply(this,arguments);if(to===filename){published=true;if(stage==='after-commit')process.exit(18);}return value;};",
          "try{b.applyBudgetModelAmendment(filename,JSON.parse(process.argv[3]),JSON.parse(process.argv[4]),JSON.parse(process.argv[5]));process.exit(0);}catch{process.exit(19);}",
        ].join("\n"),
        helper,
        ledgerPath,
        JSON.stringify(oldPlan),
        JSON.stringify(alternative),
        JSON.stringify(chosen),
        stage,
      ],
      { encoding: "utf8" }
    );
  }
  for (const stage of [
    "audit-failure",
    "file-sync-failure",
    "before-commit",
    "after-commit",
    "receipt-failure",
    "directory-sync-failure",
  ]) {
    it(
      "preserves allowance and the appropriate lock across model publication " +
        stage,
      async () => {
        const before = readFileSync(ledgerPath),
          chosen = selection(ledgerPath),
          expected = budget.prepareBudgetModelAmendment(
            ledgerPath,
            oldPlan,
            alternative,
            chosen
          );
        const outcome = fault(stage, chosen);
        expect(outcome.status, outcome.stderr).to.equal(
          stage === "before-commit" ? 17 : stage === "after-commit" ? 18 : 19
        );
        const published = [
            "after-commit",
            "receipt-failure",
            "directory-sync-failure",
          ].includes(stage),
          activePlan = published ? expected.plan : oldPlan;
        const current = read(ledgerPath),
          previous = JSON.parse(before.toString("utf8"));
        expect(current.capNanoUsd).to.equal(6e9);
        expect(current.entries).to.deep.equal(previous.entries);
        expect(current.capAuthorizations).to.deep.equal(
          previous.capAuthorizations
        );
        if (!published) expect(readFileSync(ledgerPath)).to.deep.equal(before);
        expect(existsSync(ledgerPath + ".lock")).to.equal(
          stage !== "audit-failure"
        );
        const audit = join(
          directory,
          "hedwig-budget-model-amendment-" + chosen.amendmentId
        );
        expect(readFileSync(join(audit, "ledger.before.json"))).to.deep.equal(
          before
        );
        expect(
          existsSync(join(audit, "model-amendment.applied.json"))
        ).to.equal(false);
        expect(budget.readBudgetSummary(ledgerPath, activePlan)).to.include({
          spentUsd: 0.2,
          reservedUsd: 0.786016,
          requestCount: 2,
        });
        if (stage !== "audit-failure") {
          let calls = 0;
          const guard = budget.installBudgetGuard({
            ledgerPath,
            plan: activePlan,
            fetch: async () => {
              calls++;
              return new Response();
            },
          });
          await rejects(
            () => guard(endpoint, request(activePlan.model)),
            "ledger_busy"
          );
          expect(calls).to.equal(0);
        }
      }
    );
  }
});
