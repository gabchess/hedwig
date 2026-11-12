import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect } from "chai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHedwigServer } from "../src/server-core";
import {
  createOpenRouterFoundationGenerator,
  createOpenRouterGenerator,
} from "../src/openrouter";

const source = {
  id: "fixture",
  title: "Fixture",
  url: "https://example.com/source",
  sourceFileUrl: "https://example.com/source",
  revision: "fixture@" + "a".repeat(40),
  text: "Public fixture text.",
};
const input = { question: "Public fixture question", sources: [source] };
const answer = {
  answer: "Public fixture answer.",
  citationIds: [source.id],
  unsupportedParts: [],
};
function response(content: unknown = answer, finishReason = "stop") {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: finishReason,
          message: { content: JSON.stringify(content) },
        },
      ],
    })
  );
}

describe("education lifecycle isolation (no live inference)", () => {
  it("starts consult and seed without loading the foundation corpus", () => {
    // Simulate an unavailable bundled corpus in a separate process. The real
    // server and module loader run; the repository corpus is never modified.
    const script = `
      const Module = require("node:module");
      const load = Module._load;
      Module._load = function (id, ...args) {
        if (id.endsWith("foundations.json")) throw new Error("CORPUS_UNAVAILABLE");
        return load.call(this, id, ...args);
      };
      const { createHedwigServer } = require("./mcp/src/server-core");
      createHedwigServer({ mode: "consult", policyPath: "unused", policyPin: {} });
      createHedwigServer({ mode: "education", knowledgeMode: "seed" });
      try {
        createHedwigServer({ mode: "education", knowledgeMode: "foundations" });
        throw new Error("FOUNDATIONS_DID_NOT_VALIDATE");
      } catch (error) {
        if (error.message !== "CORPUS_UNAVAILABLE") throw error;
      }
      process.stdout.write("isolated");
    `;
    const run = spawnSync(
      process.execPath,
      ["-r", "ts-node/register/transpile-only", "-e", script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TS_NODE_PROJECT: join(process.cwd(), "mcp/tsconfig.test.json"),
        },
        encoding: "utf8",
      }
    );
    expect(run.status, run.stderr).to.equal(0);
    expect(run.stdout).to.equal("isolated");
  });

  for (const profile of ["seed", "foundations"] as const) {
    it(`propagates MCP cancellation to the ${profile} provider request`, async () => {
      let started!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let complete!: (value: Response) => void;
      let requestSignal: AbortSignal | undefined;
      const fetcher = (async (_url: unknown, options: RequestInit) => {
        requestSignal = options.signal as AbortSignal;
        started();
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      }) as typeof fetch;
      const config = {
        apiKey: "test",
        model: "test/model:free",
        fetch: fetcher,
      };
      const server = createHedwigServer({
        mode: "education",
        knowledgeMode: profile,
        generate: createOpenRouterGenerator(config),
        generateFoundations: createOpenRouterFoundationGenerator(config),
      });
      const client = new Client({ name: "cancellation-fixture", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(a), server.connect(b)]);
      const controller = new AbortController();
      try {
        const call = client
          .callTool(
            {
              name: "ask_hedwig",
              arguments: { question: "What are ERC-4626 vault shares?" },
            },
            undefined,
            { signal: controller.signal }
          )
          .catch(() => undefined);
        await requestStarted;
        controller.abort();
        await call;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(requestSignal?.aborted).to.equal(true);
      } finally {
        complete(response());
        await client.close();
        await server.close();
      }
    });
  }
});

describe("provider failure diagnosis (no live inference)", () => {
  const cases = [
    {
      name: "rate limits",
      code: "rate_limited",
      fetch: async () => new Response("PRIVATE_BODY", { status: 429 }),
    },
    {
      name: "authentication rejection",
      code: "authentication_failed",
      fetch: async () => new Response("PRIVATE_BODY", { status: 401 }),
    },
    {
      name: "HTTP failures",
      code: "http_error",
      fetch: async () => new Response("PRIVATE_BODY", { status: 503 }),
    },
    {
      name: "truncated completion",
      code: "completion_truncated",
      fetch: async () => response(answer, "length"),
    },
    {
      name: "provider content refusal",
      code: "provider_refusal",
      fetch: async () => response({ answer: "PRIVATE_BODY" }, "content_filter"),
    },
    {
      name: "invalid response JSON",
      code: "invalid_response",
      fetch: async () => new Response("PRIVATE_BODY"),
    },
    {
      name: "oversized response",
      code: "response_too_large",
      fetch: async () => new Response("x".repeat(65537)),
    },
    {
      name: "transport failure",
      code: "transport_error",
      fetch: async () => {
        throw new Error("PRIVATE_BODY");
      },
    },
  ];
  for (const item of cases) {
    it(`classifies ${item.name} without retaining raw data`, async () => {
      const diagnostics: unknown[] = [];
      const config = {
        apiKey: "PRIVATE_KEY",
        model: "test/model:free",
        fetch: item.fetch as typeof fetch,
        onDiagnostic: (value: unknown) => diagnostics.push(value),
      };
      let error: unknown;
      try {
        await createOpenRouterFoundationGenerator(config)(input);
      } catch (caught) {
        error = caught;
      }
      expect(error).to.be.instanceOf(Error);
      expect(diagnostics).to.have.length(1);
      expect(diagnostics[0]).to.have.property("code", item.code);
      expect(JSON.stringify(diagnostics)).not.to.contain("PRIVATE");
      expect(String(error)).not.to.contain("PRIVATE");
    });
  }

  it("skips an already cancelled provider request", async () => {
    let calls = 0;
    const diagnostics: unknown[] = [];
    const controller = new AbortController();
    controller.abort("PRIVATE_REASON");
    const config = {
      apiKey: "test",
      model: "test/model:free",
      fetch: (async () => {
        calls++;
        return response();
      }) as typeof fetch,
      onDiagnostic: (value: unknown) => diagnostics.push(value),
    };
    const cancelledInput = { ...input, signal: controller.signal };
    await createOpenRouterFoundationGenerator(config)(cancelledInput).catch(
      () => undefined
    );
    expect(calls).to.equal(0);
    expect(diagnostics).to.deep.equal([{ code: "cancelled" }]);
  });

  it("reports numeric HTTP status without retaining the provider error body", async () => {
    for (const httpStatus of [404, 503]) {
      const diagnostics: unknown[] = [];
      await createOpenRouterFoundationGenerator({
        apiKey: "private",
        model: "test/model:free",
        fetch: (async () =>
          new Response("PRIVATE_DETAIL", {
            status: httpStatus,
          })) as typeof fetch,
        onDiagnostic: (value) => diagnostics.push(value),
      })(input).catch(() => undefined);
      expect(diagnostics).to.deep.equal([{ code: "http_error", httpStatus }]);
      expect(JSON.stringify(diagnostics)).not.to.include("PRIVATE");
    }
  });

  it("cancels a response body that is still streaming", async () => {
    const controller = new AbortController();
    const diagnostics: unknown[] = [];
    let reading!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let bodyCancelled = false;
    const config = {
      apiKey: "test",
      model: "test/model:free",
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              reading();
            },
            cancel() {
              bodyCancelled = true;
            },
          })
        )) as typeof fetch,
      onDiagnostic: (value: unknown) => diagnostics.push(value),
    };
    const pending = createOpenRouterFoundationGenerator(config)({
      ...input,
      signal: controller.signal,
    }).catch(() => undefined);
    await bodyStarted;
    controller.abort("PRIVATE_REASON");
    await pending;
    expect(bodyCancelled).to.equal(true);
    expect(diagnostics).to.deep.equal([{ code: "cancelled" }]);
  });

  it("bounds a transport that ignores abort and reports the deadline once", async function () {
    this.timeout(20_000);
    const diagnostics: unknown[] = [];
    let requestSignal: AbortSignal | undefined;
    const config = {
      apiKey: "test",
      model: "test/model:free",
      fetch: (async (_url: unknown, options: RequestInit) => {
        requestSignal = options.signal as AbortSignal;
        return new Promise<Response>(() => undefined);
      }) as typeof fetch,
      onDiagnostic: (value: unknown) => diagnostics.push(value),
    };
    await createOpenRouterFoundationGenerator(config)(input).catch(
      () => undefined
    );
    expect(requestSignal?.aborted).to.equal(true);
    expect(diagnostics).to.deep.equal([{ code: "deadline_exceeded" }]);
  });

  for (const { model, deadlineMs } of [
    { model: "openai/gpt-5.1", deadlineMs: 20_000 },
    { model: "openai/gpt-5.2", deadlineMs: 30_000 },
    { model: "qwen/qwen3-235b-a22b-2507", deadlineMs: 45_000 },
    { model: "qwen/qwen3-235b-a22b-2507:free", deadlineMs: 15_000 },
    { model: "deepseek/deepseek-v4-flash-0731", deadlineMs: 45_000 },
    { model: "deepseek/deepseek-v4-flash-20260731", deadlineMs: 15_000 },
  ]) {
    it(`applies ${model}'s deadline and still aborts the request`, async () => {
      const nativeSetTimeout = globalThis.setTimeout;
      const scheduled: number[] = [];
      let signal: AbortSignal | undefined;
      const diagnostics: unknown[] = [];
      globalThis.setTimeout = ((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        scheduled.push(delay ?? 0);
        return nativeSetTimeout(callback, 0, ...args);
      }) as typeof setTimeout;
      try {
        await createOpenRouterFoundationGenerator({
          apiKey: "test",
          model,
          fetch: (async (_url: unknown, options: RequestInit) => {
            signal = options.signal as AbortSignal;
            return new Promise<Response>(() => undefined);
          }) as typeof fetch,
          onDiagnostic: (value) => diagnostics.push(value),
        })(input).catch(() => undefined);
      } finally {
        globalThis.setTimeout = nativeSetTimeout;
      }
      expect(scheduled).to.deep.equal([deadlineMs]);
      expect(signal?.aborted).to.equal(true);
      expect(diagnostics).to.deep.equal([{ code: "deadline_exceeded" }]);
    });
  }

  it("does not let diagnostic consumers replace the sanitized failure", async () => {
    const config = {
      apiKey: "test",
      model: "test/model:free",
      fetch: (async () =>
        new Response("PRIVATE_BODY", { status: 429 })) as typeof fetch,
      onDiagnostic: () => {
        throw new Error("PRIVATE_CALLBACK_ERROR");
      },
    };
    let error: unknown;
    try {
      await createOpenRouterFoundationGenerator(config)(input);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).to.contain("rate_limited");
    expect(String(error)).not.to.contain("PRIVATE");
  });
});
