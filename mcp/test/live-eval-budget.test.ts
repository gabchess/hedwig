import { expect } from "chai";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createOpenRouterFoundationGenerator } from "../src/openrouter";

const budget = require("./live-eval-budget.js");

const endpoint = "https://openrouter.ai/api/v1/chat/completions";
const catalog = {
  id: "openai/gpt-4.1-mini",
  context_length: 1047576,
  top_provider: { max_completion_tokens: 32768 },
  pricing: {
    prompt: "0.0000004",
    completion: "0.0000016",
    web_search: "0.01",
    input_cache_read: "0.0000001",
  },
};
const strongerCatalog = {
  ...catalog,
  id: "openai/gpt-4.1",
  pricing: {
    prompt: "0.000002",
    completion: "0.000008",
    web_search: "0.01",
    input_cache_read: "0.0000005",
  },
};
const reasoningCatalog = {
  id: "openai/gpt-5.1",
  context_length: 400000,
  top_provider: { max_completion_tokens: 128000 },
  pricing: {
    prompt: "0.00000125",
    completion: "0.00001",
    web_search: "0.01",
    input_cache_read: "0.000000125",
  },
};
function writeLedgerFixture(filename: string, content: any) {
  function sorted(value: any): any {
    if (Array.isArray(value)) return value.map(sorted);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])])
    );
  }
  const { integrity: _oldIntegrity, ...body } = content;
  const integrity = createHash("sha256")
    .update(JSON.stringify(sorted(body)))
    .digest("hex");
  writeFileSync(filename, JSON.stringify({ ...body, integrity }));
}
function request(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    body: JSON.stringify({
      model: catalog.id,
      stream: false,
      max_tokens: 2048,
      temperature: 0,
      provider: {
        data_collection: "deny",
        require_parameters: true,
        allow_fallbacks: false,
        zdr: true,
      },
      messages: [{ role: "user", content: "Explain collateral." }],
      response_format: { type: "json_schema", json_schema: {} },
      ...overrides,
    }),
  };
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

describe("live evaluation durable spending boundary", () => {
  let directory: string;
  let ledgerPath: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "hedwig-budget-"));
    ledgerPath = join(directory, "ledger.json");
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("reserves the complete medium-reasoning request before GPT-5.2 generation", async () => {
    const model = {
      ...reasoningCatalog,
      id: "openai/gpt-5.2",
      pricing: { prompt: "0.00000175", completion: "0.000014" },
    };
    const plan = budget.createBudgetPlan(model, model.id);
    budget.initializeBudgetLedger(ledgerPath, plan);
    let calls = 0;
    const guarded = budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async (_url: unknown, init: RequestInit) => {
        calls++;
        const sent = JSON.parse(init.body as string);
        expect(sent.model).to.equal(model.id);
        expect(sent.max_tokens).to.equal(6144);
        expect(sent.reasoning).to.deep.equal({
          effort: "medium",
          exclude: true,
        });
        expect(sent).not.to.have.property("temperature");
        expect(budget.readBudgetSummary(ledgerPath, plan).reservedUsd).to.equal(
          0.786016
        );
        return new Response(
          JSON.stringify({
            usage: { cost: 0.012 },
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    answer: "",
                    citationIds: [],
                    unsupportedParts: ["No live data."],
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
      model: model.id,
      fetch: guarded,
    })({
      question: "Explain a live observation",
      sources: [],
    });
    expect(calls).to.equal(1);
    expect(budget.readBudgetSummary(ledgerPath, plan)).to.include({
      spentUsd: 0.012,
      reservedUsd: 0,
      remainingUsd: 4.988,
    });
    await rejects(
      () =>
        guarded(
          endpoint,
          request({
            model: model.id,
            temperature: undefined,
            max_tokens: 6144,
            reasoning: { effort: "high", exclude: true },
          })
        ),
      "request_rejected"
    );
    expect(calls).to.equal(1);
  });

  it("qualifies only the approved model and known bounded billing fields", () => {
    const plan = budget.createBudgetPlan({ data: [catalog] }, catalog.id, 5);
    expect(plan.maxPrice).to.deep.equal({
      prompt: 0.4,
      completion: 1.6,
      request: 0,
      image: 0,
    });
    expect(() => budget.createBudgetPlan(catalog, catalog.id, 5.01)).to.throw();
    expect(() => budget.createBudgetPlan(catalog, "other/model", 5)).to.throw();
    for (const pricing of [
      { ...catalog.pricing, future_fee: "0.01" },
      { ...catalog.pricing, input_cache_read: "0.0000005" },
      { ...catalog.pricing, prompt: "NaN" },
    ])
      expect(() =>
        budget.createBudgetPlan({ ...catalog, pricing }, catalog.id, 5)
      ).to.throw();
  });

  it("qualifies the explicitly selected stronger model without automatic fallback", () => {
    const plan = budget.createBudgetPlan(
      { data: [catalog, strongerCatalog] },
      strongerCatalog.id,
      5
    );
    expect(plan.model).to.equal(strongerCatalog.id);
    expect(plan.maxPrice).to.deep.equal({
      prompt: 2,
      completion: 8,
      request: 0,
      image: 0,
    });
    expect(() =>
      budget.createBudgetPlan({ data: [catalog] }, strongerCatalog.id, 5)
    ).to.throw();
  });

  it("reserves combined reasoning and answer costs under the same amended ledger", async () => {
    const oldPlan = budget.createBudgetPlan(catalog);
    budget.initializeBudgetLedger(ledgerPath, oldPlan);
    await budget.installBudgetGuard({
      ledgerPath,
      plan: oldPlan,
      fetch: async () => new Response('{"usage":{"cost":0.01}}'),
    })(endpoint, request());
    const plan = budget.createBudgetPlan(reasoningCatalog, reasoningCatalog.id);
    expect(plan.maxPrice).to.deep.equal({
      prompt: 1.25,
      completion: 10,
      request: 0,
      image: 0,
    });
    budget.amendBudgetPlan(ledgerPath, oldPlan, plan);
    const guarded = budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async (_url: unknown, init: RequestInit) => {
        const sent = JSON.parse(init.body as string);
        expect(sent.reasoning).to.deep.equal({ effort: "low", exclude: true });
        expect(sent).not.to.have.property("temperature");
        expect(budget.readBudgetSummary(ledgerPath, plan)).to.include({
          spentUsd: 0.01,
          reservedUsd: 0.54096,
          requestCount: 2,
        });
        return new Response(
          JSON.stringify({
            usage: {
              cost: 0.03,
              completion_tokens_details: { reasoning_tokens: 2500 },
            },
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    answer: "",
                    citationIds: [],
                    unsupportedParts: ["No current observation."],
                  }),
                },
              },
            ],
          })
        );
      },
    });
    const generate = createOpenRouterFoundationGenerator({
      apiKey: "fixture",
      model: reasoningCatalog.id,
      fetch: guarded,
    });
    await generate({
      question: "Explain this observation",
      sources: [
        {
          id: "reference",
          title: "Reference",
          text: "Historical observation.",
          url: "https://example.com/source",
          sourceFileUrl: "https://example.com/source",
          revision: "fixture",
        },
      ],
    });
    expect(budget.readBudgetSummary(ledgerPath, plan)).to.include({
      spentUsd: 0.04,
      reservedUsd: 0,
      remainingUsd: 4.96,
    });
  });

  it("admits only the exact approved reasoning profile before any paid request", async () => {
    const plan = budget.createBudgetPlan(reasoningCatalog, reasoningCatalog.id);
    budget.initializeBudgetLedger(ledgerPath, plan);
    let calls = 0;
    const guarded = budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () => {
        calls++;
        return new Response();
      },
    });
    const profile = {
      model: reasoningCatalog.id,
      max_tokens: 4096,
      temperature: undefined,
      reasoning: { effort: "low", exclude: true },
    };
    for (const change of [
      { temperature: 0 },
      { reasoning: undefined },
      { reasoning: { effort: "medium", exclude: true } },
      { reasoning: { effort: "low", exclude: false } },
      { reasoning: { effort: "low", exclude: true, enabled: true } },
      { max_tokens: 4097 },
      { max_tokens: 2048 },
    ])
      await rejects(
        () => guarded(endpoint, request({ ...profile, ...change })),
        "request_rejected"
      );
    expect(calls).to.equal(0);
    expect(budget.readBudgetSummary(ledgerPath, plan).requestCount).to.equal(0);
  });

  it("explicitly upgrades a legacy ledger while retaining every prior charge and reservation", async () => {
    const oldPlan = budget.createBudgetPlan(catalog);
    const newPlan = budget.createBudgetPlan(
      strongerCatalog,
      strongerCatalog.id
    );
    const entries = [0.04, 0.03].map((cost, index) => ({
      id: `legacy-${index}`,
      maxTokens: 2048,
      reservedNanoUsd: 422307200,
      status: "settled",
      costNanoUsd: cost * 1e9,
    }));
    writeLedgerFixture(ledgerPath, {
      schemaVersion: 1,
      planHash: oldPlan.planHash,
      capNanoUsd: oldPlan.capNanoUsd,
      entries,
    });
    let oldCalls = 0;
    const oldGuard = budget.installBudgetGuard({
      ledgerPath,
      plan: oldPlan,
      fetch: async () => {
        oldCalls++;
        return new Response();
      },
    });
    expect(budget.amendBudgetPlan(ledgerPath, oldPlan, newPlan)).to.include({
      spentUsd: 0.07,
      reservedUsd: 0,
      remainingUsd: 4.93,
      requestCount: 2,
    });
    const migrated = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(migrated.schemaVersion).to.equal(2);
    expect(migrated.planHistory).to.deep.equal([oldPlan, newPlan]);
    expect(migrated.entries).to.deep.equal(
      entries.map((entry) => ({ ...entry, planHash: oldPlan.planHash }))
    );
    await rejects(() => oldGuard(endpoint, request()), "invalid_ledger");
    expect(oldCalls).to.equal(0);
    expect(() => budget.initializeBudgetLedger(ledgerPath, oldPlan)).to.throw();
    const guarded = budget.installBudgetGuard({
      ledgerPath,
      plan: newPlan,
      fetch: async () => {
        expect(budget.readBudgetSummary(ledgerPath, newPlan)).to.include({
          spentUsd: 0.07,
          reservedUsd: 2.111536,
          requestCount: 3,
        });
        return new Response('{"usage":{"cost":0.05}}');
      },
    });
    await guarded(endpoint, request({ model: strongerCatalog.id }));
    expect(budget.readBudgetSummary(ledgerPath, newPlan)).to.include({
      spentUsd: 0.12,
      reservedUsd: 0,
      remainingUsd: 4.88,
      requestCount: 3,
    });
    const updated = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(updated.entries[2].planHash).to.equal(newPlan.planHash);
  });

  it("refuses any cap change and preserves the existing ledger bytes", () => {
    const oldPlan = budget.createBudgetPlan(catalog, catalog.id, 4);
    budget.initializeBudgetLedger(ledgerPath, oldPlan);
    const before = readFileSync(ledgerPath, "utf8");
    for (const cap of [3, 5]) {
      const changed = budget.createBudgetPlan(
        strongerCatalog,
        strongerCatalog.id,
        cap
      );
      expect(() =>
        budget.amendBudgetPlan(ledgerPath, oldPlan, changed)
      ).to.throw("cap_change_refused");
      expect(readFileSync(ledgerPath, "utf8")).to.equal(before);
    }
  });

  it("counts earlier model charges against admission under the amended plan", async () => {
    const oldPlan = budget.createBudgetPlan(catalog, catalog.id, 3);
    const newPlan = budget.createBudgetPlan(
      strongerCatalog,
      strongerCatalog.id,
      3
    );
    budget.initializeBudgetLedger(ledgerPath, oldPlan);
    const previous = budget.installBudgetGuard({
      ledgerPath,
      plan: oldPlan,
      fetch: async () => new Response('{"usage":{"cost":0.4}}'),
    });
    for (let count = 0; count < 3; count++) await previous(endpoint, request());
    budget.amendBudgetPlan(ledgerPath, oldPlan, newPlan);
    let calls = 0;
    const current = budget.installBudgetGuard({
      ledgerPath,
      plan: newPlan,
      fetch: async () => {
        calls++;
        return new Response();
      },
    });
    await rejects(
      () => current(endpoint, request({ model: strongerCatalog.id })),
      "cap_exhausted"
    );
    await rejects(() => current(endpoint, request()), "request_rejected");
    expect(calls).to.equal(0);
    expect(budget.readBudgetSummary(ledgerPath, newPlan)).to.include({
      spentUsd: 1.2,
      remainingUsd: 1.8,
      requestCount: 3,
    });
    expect(() => budget.amendBudgetPlan(ledgerPath, newPlan, oldPlan)).to.throw(
      "invalid_plan"
    );
  });

  it("refuses amendment with an active lock or an uncertain reservation", async () => {
    const oldPlan = budget.createBudgetPlan(catalog);
    const newPlan = budget.createBudgetPlan(
      strongerCatalog,
      strongerCatalog.id
    );
    budget.initializeBudgetLedger(ledgerPath, oldPlan);
    writeFileSync(`${ledgerPath}.lock`, "active", { flag: "wx" });
    expect(() => budget.amendBudgetPlan(ledgerPath, oldPlan, newPlan)).to.throw(
      "ledger_busy"
    );
    rmSync(`${ledgerPath}.lock`);
    await budget.installBudgetGuard({
      ledgerPath,
      plan: oldPlan,
      fetch: async () => new Response('{"usage":{}}'),
    })(endpoint, request());
    const before = readFileSync(ledgerPath, "utf8");
    expect(() => budget.amendBudgetPlan(ledgerPath, oldPlan, newPlan)).to.throw(
      "unsettled_request"
    );
    expect(readFileSync(ledgerPath, "utf8")).to.equal(before);
  });

  it("validates history and each original reservation even with a recalculated outer checksum", async () => {
    const oldPlan = budget.createBudgetPlan(catalog);
    const newPlan = budget.createBudgetPlan(
      strongerCatalog,
      strongerCatalog.id
    );
    budget.initializeBudgetLedger(ledgerPath, oldPlan);
    await budget.installBudgetGuard({
      ledgerPath,
      plan: oldPlan,
      fetch: async () => new Response('{"usage":{"cost":0.01}}'),
    })(endpoint, request());
    budget.amendBudgetPlan(ledgerPath, oldPlan, newPlan);
    const valid = JSON.parse(readFileSync(ledgerPath, "utf8"));
    for (const corrupt of [
      (ledger: any) => {
        ledger.planHistory[0].contextLength++;
      },
      (ledger: any) => {
        ledger.planHistory.shift();
      },
      (ledger: any) => {
        ledger.entries[0].planHash = "unregistered";
      },
      (ledger: any) => {
        ledger.entries[0].reservedNanoUsd = 2111536000;
      },
    ]) {
      const altered = structuredClone(valid);
      corrupt(altered);
      writeLedgerFixture(ledgerPath, altered);
      expect(() => budget.readBudgetSummary(ledgerPath, newPlan)).to.throw();
    }
  });

  it("reserves the entire input context before a request and preserves the response", async () => {
    const plan = budget.createBudgetPlan(catalog);
    budget.initializeBudgetLedger(ledgerPath, plan);
    let observed: any;
    const response = new Response(
      JSON.stringify({
        usage: { cost: 0.0123 },
        choices: [{ text: "unchanged" }],
      })
    );
    const guarded = budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async (_url: unknown, init: any) => {
        observed = JSON.parse(init.body);
        const pending = budget.readBudgetSummary(ledgerPath, plan);
        expect(pending.reservedUsd).to.be.closeTo(0.4223072, 1e-9);
        expect(pending.blocked).to.equal(true);
        expect(init.redirect).to.equal("error");
        return response;
      },
    });
    expect(await guarded(endpoint, request())).to.equal(response);
    expect(await response.text()).to.equal(
      JSON.stringify({
        usage: { cost: 0.0123 },
        choices: [{ text: "unchanged" }],
      })
    );
    expect(observed.provider.max_price).to.deep.equal(plan.maxPrice);
    expect(budget.readBudgetSummary(ledgerPath, plan)).to.include({
      spentUsd: 0.0123,
      reservedUsd: 0,
      blocked: false,
      requestCount: 1,
    });
  });

  it("refuses an insufficient cap before making any network request", async () => {
    const plan = budget.createBudgetPlan(catalog, catalog.id, 0.4);
    budget.initializeBudgetLedger(ledgerPath, plan);
    let calls = 0;
    const guarded = budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () => {
        calls++;
        return new Response();
      },
    });
    await rejects(() => guarded(endpoint, request()), "cap_exhausted");
    expect(calls).to.equal(0);
    expect(budget.readBudgetSummary(ledgerPath, plan).requestCount).to.equal(0);
  });

  it("retains a missing cost reservation and blocks a fresh guard and ledger initializer", async () => {
    const plan = budget.createBudgetPlan(catalog);
    budget.initializeBudgetLedger(ledgerPath, plan);
    const guarded = budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () => new Response('{"usage":{}}'),
    });
    await guarded(endpoint, request());
    budget.initializeBudgetLedger(ledgerPath, plan);
    const restarted = budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () => {
        throw new Error("must not call");
      },
    });
    await rejects(() => restarted(endpoint, request()), "unsettled_request");
    expect(budget.readBudgetSummary(ledgerPath, plan)).to.include({
      spentUsd: 0,
      reservedUsd: 0.4223072,
      blocked: true,
      requestCount: 1,
    });
  });

  it("carries settled spend across guard restarts and refuses before the total cap", async () => {
    const plan = budget.createBudgetPlan(catalog, catalog.id, 1);
    budget.initializeBudgetLedger(ledgerPath, plan);
    let calls = 0;
    const options = {
      ledgerPath,
      plan,
      fetch: async () => {
        calls++;
        return new Response('{"usage":{"cost":0.3}}');
      },
    };
    await budget.installBudgetGuard(options)(endpoint, request());
    budget.initializeBudgetLedger(ledgerPath, plan);
    await budget.installBudgetGuard(options)(endpoint, request());
    await rejects(
      () => budget.installBudgetGuard(options)(endpoint, request()),
      "cap_exhausted"
    );
    expect(calls).to.equal(2);
    expect(budget.readBudgetSummary(ledgerPath, plan)).to.include({
      spentUsd: 0.6,
      reservedUsd: 0,
      remainingUsd: 0.4,
      requestCount: 2,
    });
  });

  it("never treats nonnumeric, negative, or excessive cost as zero", async () => {
    const plan = budget.createBudgetPlan(catalog);
    for (const [index, cost] of ["0", null, -1, 1].entries()) {
      const path = join(directory, `${index}.json`);
      budget.initializeBudgetLedger(path, plan);
      const guarded = budget.installBudgetGuard({
        ledgerPath: path,
        plan,
        fetch: async () => new Response(JSON.stringify({ usage: { cost } })),
      });
      await guarded(endpoint, request());
      expect(budget.readBudgetSummary(path, plan).blocked).to.equal(true);
      expect(budget.readBudgetSummary(path, plan).reservedUsd).to.equal(
        0.4223072
      );
    }
  });

  it("serializes independent guards with an atomic on-disk lock", async () => {
    const plan = budget.createBudgetPlan(catalog);
    budget.initializeBudgetLedger(ledgerPath, plan);
    let release!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () => {
        entered();
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      },
    });
    const second = budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () => {
        throw new Error("must not call");
      },
    });
    const running = first(endpoint, request());
    await started;
    await rejects(() => second(endpoint, request()), "ledger_busy");
    release(new Response('{"usage":{"cost":0.01}}'));
    await running;
    expect(budget.readBudgetSummary(ledgerPath, plan).requestCount).to.equal(1);
  });

  it("does not recover an unfinished process lock automatically", async () => {
    const plan = budget.createBudgetPlan(catalog);
    budget.initializeBudgetLedger(ledgerPath, plan);
    writeFileSync(`${ledgerPath}.lock`, "interrupted-process", { flag: "wx" });
    const guarded = budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () => new Response(),
    });
    await rejects(() => guarded(endpoint, request()), "ledger_busy");
  });

  it("rejects changed prices, tampered plans, and tampered ledger totals", () => {
    const plan = budget.createBudgetPlan(catalog);
    budget.initializeBudgetLedger(ledgerPath, plan);
    const changed = budget.createBudgetPlan({
      ...catalog,
      pricing: { ...catalog.pricing, completion: "0.000002" },
    });
    expect(() => budget.initializeBudgetLedger(ledgerPath, changed)).to.throw();
    expect(() =>
      budget.initializeBudgetLedger(ledgerPath, {
        ...plan,
        capNanoUsd: 6000000000,
      })
    ).to.throw();
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    ledger.entries.push({ status: "settled", costNanoUsd: 0 });
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    expect(() => budget.readBudgetSummary(ledgerPath, plan)).to.throw();
  });

  it("denies alternate models, paid extras, malformed messages, streaming and excessive output", async () => {
    const plan = budget.createBudgetPlan(catalog);
    budget.initializeBudgetLedger(ledgerPath, plan);
    let calls = 0;
    const guarded = budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () => {
        calls++;
        return new Response();
      },
    });
    for (const change of [
      { model: "other/model" },
      { models: [catalog.id] },
      { tools: [] },
      { plugins: [] },
      { web_search_options: {} },
      { stream: true },
      { max_tokens: 32769 },
      { temperature: 1 },
      { reasoning: { effort: "low", exclude: true } },
      {
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: "private" }],
          },
        ],
      },
      { provider: { allow_fallbacks: true } },
    ])
      await rejects(
        () => guarded(endpoint, request(change)),
        "request_rejected"
      );
    expect(calls).to.equal(0);
  });

  it("retains the reservation after a network error without leaking raw diagnostics", async () => {
    const plan = budget.createBudgetPlan(catalog);
    budget.initializeBudgetLedger(ledgerPath, plan);
    const diagnostics: string[] = [];
    const guarded = budget.installBudgetGuard({
      ledgerPath,
      plan,
      onDiagnostic: (code: string) => diagnostics.push(code),
      fetch: async () => {
        throw new Error("secret provider body");
      },
    });
    await rejects(() => guarded(endpoint, request()), "request_uncertain");
    expect(diagnostics).to.deep.equal(["request_uncertain"]);
    expect(readFileSync(ledgerPath, "utf8")).not.to.contain("secret");
    expect(budget.readBudgetSummary(ledgerPath, plan).blocked).to.equal(true);
  });

  it("preloads in a separate process and blocks a call without touching the network", () => {
    const plan = budget.createBudgetPlan(catalog, catalog.id, 0.4);
    budget.initializeBudgetLedger(ledgerPath, plan);
    const planPath = join(directory, "plan.json");
    writeFileSync(planPath, JSON.stringify(plan));
    const program = `fetch(${JSON.stringify(endpoint)}, ${JSON.stringify(
      request()
    )}).then(() => process.exit(9)).catch(error => { process.stdout.write(error.message); });`;
    const child = spawnSync(
      process.execPath,
      ["--require", join(__dirname, "live-eval-budget.js"), "-e", program],
      {
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          HEDWIG_EVAL_BUDGET_PRELOAD: "1",
          HEDWIG_EVAL_BUDGET_PLAN: planPath,
          HEDWIG_EVAL_BUDGET_LEDGER: ledgerPath,
        },
      }
    );
    expect(child.status).to.equal(0);
    expect(child.stdout).to.contain("cap_exhausted");
    expect(child.stderr).to.equal("hedwig-budget: code=cap_exhausted\n");
    expect(budget.readBudgetSummary(ledgerPath, plan).requestCount).to.equal(0);
  });
});
