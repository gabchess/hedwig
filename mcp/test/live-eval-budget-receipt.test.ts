import { expect } from "chai";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

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
    messages: [{ role: "user", content: "Public receipt fixture." }],
    response_format: { type: "json_schema", json_schema: {} },
  }),
};
const entries = (filename: string) =>
  JSON.parse(readFileSync(filename, "utf8")).entries;

describe("prospective provider generation identity receipts", () => {
  let directory: string;
  let ledgerPath: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "hedwig-generation-receipt-"));
    ledgerPath = join(directory, "ledger.json");
    budget.initializeBudgetLedger(ledgerPath, plan);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("persists the valid header identity before attempting a truncated response body", async () => {
    const response = new Response('{"id":', {
      headers: { "X-Generation-Id": "gen-header_first" },
    });
    const clone = response.clone.bind(response);
    let beforeBody: any;
    Object.defineProperty(response, "clone", {
      value: () => {
        beforeBody = entries(ledgerPath)[0];
        return clone();
      },
    });
    await budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () => response,
    })(endpoint, request);
    expect(beforeBody).to.include({
      generationId: "gen-header_first",
      status: "reserved",
    });
    expect(beforeBody.responseReceivedAt).to.be.a("string");
    expect(entries(ledgerPath)[0]).to.include({
      generationId: "gen-header_first",
      status: "uncertain",
    });
    expect(entries(ledgerPath)[0]).not.to.have.property("costNanoUsd");
    expect(budget.readBudgetSummary(ledgerPath, plan)).to.include({
      blocked: true,
      reservedUsd: 0.4223072,
    });
  });

  it("preserves the header identity when reading the response body is cancelled", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      }),
      { headers: { "x-generation-id": "gen-cancelled" } }
    );
    const clone = response.clone.bind(response);
    Object.defineProperty(response, "clone", {
      value: () => {
        const copied = clone();
        controller.error(
          new DOMException("PRIVATE_PROVIDER_BODY", "AbortError")
        );
        return copied;
      },
    });
    await budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () => response,
    })(endpoint, request);
    expect(entries(ledgerPath)[0]).to.include({
      generationId: "gen-cancelled",
      status: "uncertain",
    });
    expect(entries(ledgerPath)[0]).not.to.have.property("costNanoUsd");
    expect(readFileSync(ledgerPath, "utf8")).not.to.contain(
      "PRIVATE_PROVIDER_BODY"
    );
    expect(budget.readBudgetSummary(ledgerPath, plan).blocked).to.equal(true);
  });

  it("retains the header through the production receipt-deadline path without settling an unknown cost", () => {
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const budget = require(process.argv[1]);
      const set = globalThis.setTimeout;
      let configuredDeadline;
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay === 15000) { configuredDeadline = delay; return set(callback, 5, ...args); }
        return set(callback, delay, ...args);
      };
      const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }),
        { headers: { 'X-Generation-Id': 'gen-deadline' } });
      budget.installBudgetGuard({ ledgerPath: process.argv[2], plan: JSON.parse(process.argv[3]), fetch: async () => response })
        (${JSON.stringify(endpoint)}, JSON.parse(process.argv[4])).then(() => {
          if (configuredDeadline !== 15000) process.exit(2);
          process.exit(0);
        }, () => process.exit(3));
    `,
        helper,
        ledgerPath,
        JSON.stringify(plan),
        JSON.stringify(request),
      ],
      { encoding: "utf8", timeout: 5000 }
    );
    expect(child.status, child.stderr).to.equal(0);
    expect(entries(ledgerPath)[0]).to.include({
      generationId: "gen-deadline",
      status: "uncertain",
    });
    expect(entries(ledgerPath)[0]).not.to.have.property("costNanoUsd");
    expect(budget.readBudgetSummary(ledgerPath, plan)).to.include({
      blocked: true,
      reservedUsd: 0.4223072,
    });
  });

  it("retains the header and lock if the process exits before reading the body", () => {
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const budget = require(process.argv[1]);
      const response = new Response('{}', { headers: { 'X-Generation-Id': 'gen-before-body-crash' } });
      response.clone = () => process.exit(29);
      budget.installBudgetGuard({ ledgerPath: process.argv[2], plan: JSON.parse(process.argv[3]), fetch: async () => response })
        (${JSON.stringify(
          endpoint
        )}, JSON.parse(process.argv[4])).catch(() => process.exit(3));
    `,
        helper,
        ledgerPath,
        JSON.stringify(plan),
        JSON.stringify(request),
      ],
      { encoding: "utf8", timeout: 5000 }
    );
    expect(child.status, child.stderr).to.equal(29);
    expect(entries(ledgerPath)[0]).to.include({
      generationId: "gen-before-body-crash",
      status: "reserved",
    });
    expect(existsSync(`${ledgerPath}.lock`)).to.equal(true);
    expect(budget.readBudgetSummary(ledgerPath, plan).blocked).to.equal(true);
  });

  it("settles matching IDs and supports the existing body-only identity path", async () => {
    for (const header of ["gen-matching", undefined]) {
      const response = new Response(
        JSON.stringify({ id: "gen-matching", usage: { cost: 0.01 } }),
        { headers: header ? { "X-Generation-Id": header } : undefined }
      );
      await budget.installBudgetGuard({
        ledgerPath,
        plan,
        fetch: async () => response,
      })(endpoint, request);
      expect(entries(ledgerPath).at(-1)).to.include({
        generationId: "gen-matching",
        status: "settled",
        costNanoUsd: 10000000,
      });
      expect(entries(ledgerPath).at(-1)).not.to.have.property("receiptIssue");
    }
    expect(budget.readBudgetSummary(ledgerPath, plan)).to.include({
      spentUsd: 0.02,
      blocked: false,
    });
  });

  it("accepts only the exact existing identifier grammar and never retains malformed header text", async () => {
    const good = `gen-${"a".repeat(196)}`;
    for (const header of [
      good,
      "gen-",
      `gen-${"a".repeat(197)}`,
      "PRIVATE/HEADER",
      "gen-one, gen-two",
    ]) {
      const response = new Response('{"usage":{"cost":0.01}}', {
        headers: { "X-Generation-Id": header },
      });
      await budget.installBudgetGuard({
        ledgerPath,
        plan,
        fetch: async () => response,
      })(endpoint, request);
      const entry = entries(ledgerPath).at(-1);
      if (header === good) expect(entry.generationId).to.equal(good);
      else expect(entry).not.to.have.property("generationId");
    }
    expect(readFileSync(ledgerPath, "utf8")).not.to.contain("PRIVATE/HEADER");
    expect(budget.readBudgetSummary(ledgerPath, plan)).to.include({
      spentUsd: 0.05,
      blocked: false,
    });
  });

  for (const bodyId of ["gen-different", "PRIVATE_INVALID_ID"]) {
    it(`refuses a conflicting ${
      bodyId.startsWith("gen-") ? "valid" : "malformed"
    } body ID without overwriting the header or using its cost`, async () => {
      const diagnostics: string[] = [];
      let returned = false;
      let failure: unknown;
      try {
        await budget.installBudgetGuard({
          ledgerPath,
          plan,
          onDiagnostic: (code: string) => diagnostics.push(code),
          fetch: async () =>
            new Response(
              JSON.stringify({
                id: bodyId,
                usage: { cost: 0.01 },
                private: "PRIVATE_CONTENT",
              }),
              { headers: { "X-Generation-Id": "gen-first-header" } }
            ),
        })(endpoint, request);
        returned = true;
      } catch (error) {
        failure = error;
      }
      expect(returned).to.equal(false);
      expect(String(failure)).to.contain("generation_id_conflict");
      expect(diagnostics).to.deep.equal(["generation_id_conflict"]);
      expect(entries(ledgerPath)[0]).to.include({
        generationId: "gen-first-header",
        status: "uncertain",
        receiptIssue: "generation_id_conflict",
      });
      expect(entries(ledgerPath)[0]).not.to.have.property("costNanoUsd");
      expect(budget.readBudgetSummary(ledgerPath, plan)).to.include({
        spentUsd: 0,
        reservedUsd: 0.4223072,
        blocked: true,
      });
      expect(readFileSync(ledgerPath, "utf8")).not.to.contain(
        "PRIVATE_CONTENT"
      );
      expect(readFileSync(ledgerPath, "utf8")).not.to.contain(
        "PRIVATE_INVALID_ID"
      );
    });
  }
});
