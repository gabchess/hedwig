import { expect } from "chai";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createOpenRouterFoundationGenerator } from "../src/openrouter";
const budget = require("./live-eval-budget.js");
const model = "deepseek/deepseek-v4-flash-0731";
const endpoint = "https://openrouter.ai/api/v1/chat/completions";
const catalog = {
  id: model,
  context_length: 1048576,
  top_provider: { max_completion_tokens: 943718 },
  pricing: {
    prompt: "0.0000000434",
    completion: "0.0000003",
    input_cache_read: "0.000000035",
  },
};
const source = {
  id: "fixture-source",
  url: "https://example.com/source",
  sourceFileUrl: "https://example.com/source",
  title: "Retained fixture",
  revision: "fixture-only",
  text: "A public retained statement.",
};
const input = { question: "Explain this public statement.", sources: [source] };
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
function body() {
  return {
    model,
    stream: false,
    reasoning: { effort: "high", exclude: true },
    max_tokens: 8192,
    provider: {
      data_collection: "deny",
      require_parameters: true,
      allow_fallbacks: false,
      zdr: true,
    },
    messages: [{ role: "user", content: "Public fixture." }],
    response_format: { type: "json_schema", json_schema: {} },
  };
}
describe("bounded DeepSeek Flash evaluation policy", () => {
  let directory: string, ledgerPath: string, plan: any;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "hedwig-deepseek-policy-"));
    ledgerPath = join(directory, "ledger.json");
    plan = budget.createBudgetPlan(catalog, model);
    budget.initializeBudgetLedger(ledgerPath, plan);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  it("reserves all bounded reasoning tokens before sending one unchanged evidence packet", async () => {
    let calls = 0;
    const guard = budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async (_url: unknown, init: RequestInit) => {
        calls++;
        const sent = JSON.parse(init.body as string);
        expect(sent).to.include({ model, max_tokens: 8192, stream: false });
        expect(sent.reasoning).to.deep.equal({ effort: "high", exclude: true });
        expect(sent).not.to.have.property("temperature");
        expect(sent.provider).to.deep.equal({
          data_collection: "deny",
          require_parameters: true,
          allow_fallbacks: false,
          zdr: true,
          max_price: { prompt: 0.044, completion: 0.3, request: 0, image: 0 },
        });
        expect(JSON.parse(sent.messages[1].content)).to.deep.equal(input);
        expect(sent.response_format.json_schema.strict).to.equal(true);
        expect(budget.readBudgetSummary(ledgerPath, plan).reservedUsd).to.equal(
          0.048594944
        );
        return new Response(
          JSON.stringify({
            id: "gen-deepseek-fixture",
            usage: { cost: 0.001 },
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    answer: source.text,
                    citationIds: [source.id],
                    unsupportedParts: [],
                  }),
                },
              },
            ],
          })
        );
      },
    });
    expect(
      await createOpenRouterFoundationGenerator({
        apiKey: "fixture",
        model,
        fetch: guard,
      })(input)
    ).to.deep.equal({
      answer: source.text,
      citationIds: [source.id],
      unsupportedParts: [],
    });
    expect(calls).to.equal(1);
    expect(budget.readBudgetSummary(ledgerPath, plan)).to.include({
      spentUsd: 0.001,
      reservedUsd: 0,
      requestCount: 1,
      blocked: false,
    });
  });
  it("rejects altered reasoning, token and privacy policies without reserving or fetching", async () => {
    let calls = 0;
    const guard = budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () => {
        calls++;
        return new Response("{}");
      },
    });
    const before = readFileSync(ledgerPath);
    const mutations: Array<(b: any) => void> = [
      (b) => {
        b.reasoning.effort = "medium";
      },
      (b) => {
        b.reasoning.exclude = false;
      },
      (b) => {
        b.reasoning.max_tokens = 8192;
      },
      (b) => {
        delete b.reasoning;
      },
      (b) => {
        b.temperature = 0;
      },
      (b) => {
        b.max_tokens = 8193;
      },
      (b) => {
        b.max_tokens = 4096;
      },
      (b) => {
        b.provider.sort = "throughput";
      },
      (b) => {
        b.provider.order = ["wafer/us"];
      },
      (b) => {
        b.provider.zdr = false;
      },
      (b) => {
        b.provider.allow_fallbacks = true;
      },
      (b) => {
        b.provider.require_parameters = false;
      },
      (b) => {
        b.provider.data_collection = "allow";
      },
      (b) => {
        b.provider.max_price = { prompt: 1, completion: 1 };
      },
      (b) => {
        b.model += ":free";
      },
    ];
    for (const mutate of mutations) {
      const request = body();
      mutate(request);
      let error: unknown;
      try {
        await guard(endpoint, {
          method: "POST",
          body: JSON.stringify(request),
        });
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).to.include("request_rejected");
      expect(readFileSync(ledgerPath)).to.deep.equal(before);
    }
    expect(calls).to.equal(0);
    for (const alias of [
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-20260731",
      model + ":free",
    ])
      expect(() =>
        budget.createBudgetPlan({ ...catalog, id: alias }, alias)
      ).to.throw("invalid_plan");
  });
  it("retains the complete reservation when the 90 second receipt deadline expires", () => {
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        [
          "const b=require(process.argv[1]),set=globalThis.setTimeout;let configured;",
          "globalThis.setTimeout=(callback,delay,...args)=>{if(delay===15000||delay===45000||delay===90000){configured=delay;return set(callback,5,...args);}return set(callback,delay,...args);};",
          "const response=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}}),{headers:{'X-Generation-Id':'gen-deepseek-timeout'}});",
          "b.installBudgetGuard({ledgerPath:process.argv[2],plan:JSON.parse(process.argv[3]),fetch:async()=>response})(process.argv[4],JSON.parse(process.argv[5])).then(()=>process.exit(configured===90000?0:2),()=>process.exit(3));",
        ].join("\n"),
        resolve(__dirname, "live-eval-budget.js"),
        ledgerPath,
        JSON.stringify(plan),
        endpoint,
        JSON.stringify({ method: "POST", body: JSON.stringify(body()) }),
      ],
      { encoding: "utf8", timeout: 5000 }
    );
    expect(child.status, child.stderr).to.equal(0);
    expect(read(ledgerPath).entries.at(-1)).to.include({
      status: "uncertain",
      generationId: "gen-deepseek-timeout",
      reservedNanoUsd: 48594944,
    });
    expect(budget.readBudgetSummary(ledgerPath, plan)).to.include({
      blocked: true,
      reservedUsd: 0.048594944,
    });
  });
});
