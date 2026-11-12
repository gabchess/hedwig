import { expect } from "chai";
import { createOpenRouterGenerator } from "../src/openrouter";

const source = {
  id: "erc4626-shares",
  url: "https://eips.ethereum.org/EIPS/eip-4626",
  text: "Shares represent underlying holdings.",
};
const input = {
  question: "What are ERC-4626 vault shares?",
  sources: [source],
};
function completion(content: unknown) {
  return new Response(
    JSON.stringify({
      id: "fixture",
      model: "test/model:free",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content },
        },
      ],
    }),
    { status: 200 }
  );
}
async function rejected(run: () => Promise<unknown>) {
  let failed = false;
  try {
    await run();
  } catch {
    failed = true;
  }
  expect(failed).to.equal(true);
}

describe("OpenRouter answer adapter (fixture transport, no live inference)", () => {
  it("sends retrieved evidence to the configured model and parses its answer", async () => {
    let request: RequestInit | undefined;
    let url = "";
    const fetcher = (async (u: unknown, opts: RequestInit) => {
      url = String(u);
      request = opts;
      return completion(
        JSON.stringify({
          answer: "Shares represent a claim on holdings.",
          citationIds: [source.id],
        })
      );
    }) as typeof fetch;
    const generate = createOpenRouterGenerator({
      apiKey: "test-key",
      model: "test/model:free",
      fetch: fetcher,
    });
    expect(await generate(input)).to.deep.equal({
      answer: "Shares represent a claim on holdings.",
      citationIds: [source.id],
    });
    expect(url).to.equal("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(request!.body as string);
    expect(body.model).to.equal("test/model:free");
    expect(body.models).to.equal(undefined);
    expect(body.tools).to.equal(undefined);
    expect(body.provider.data_collection).to.equal("deny");
    expect(body.provider.require_parameters).to.equal(true);
    expect(body.provider.allow_fallbacks).to.equal(false);
    expect(body.response_format.type).to.equal("json_schema");
    expect(JSON.parse(body.messages[1].content)).to.deep.equal(input);
    expect(request!.redirect).to.equal("error");
    expect(request!.signal).to.be.instanceOf(AbortSignal);
  });
  it("requires zero-retention routing for a non-free model", async () => {
    let body: any;
    const fetcher = (async (_: unknown, opts: RequestInit) => {
      body = JSON.parse(opts.body as string);
      return completion(JSON.stringify({ answer: "", citationIds: [] }));
    }) as typeof fetch;
    await createOpenRouterGenerator({
      apiKey: "test-key",
      model: "test/model",
      fetch: fetcher,
    })(input);
    expect(body.provider.zdr).to.equal(true);
    expect(body.provider.data_collection).to.equal("deny");
  });
  it("rejects missing configuration and automatic model routing", () => {
    for (const config of [
      { apiKey: "", model: "test/model" },
      { apiKey: "test", model: "" },
      { apiKey: "test", model: "openrouter/auto" },
      { apiKey: "test", model: "openrouter/free" },
    ]) {
      expect(() => createOpenRouterGenerator(config)).to.throw();
    }
  });
  it("fails on HTTP failure without retry or fallback", async () => {
    let calls = 0;
    let cancelled = false;
    const fetcher = (async () => {
      calls++;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 429 }
      );
    }) as typeof fetch;
    await rejected(() =>
      createOpenRouterGenerator({
        apiKey: "test",
        model: "test/model",
        fetch: fetcher,
      })(input)
    );
    expect(calls).to.equal(1);
    expect(cancelled).to.equal(true);
  });
  it("rejects malformed or extra answer fields", async () => {
    for (const value of [
      "not-json",
      JSON.stringify({ answer: 42, citationIds: [] }),
      JSON.stringify({ answer: "ok", citationIds: [42] }),
      JSON.stringify({ answer: "ok", citationIds: [], proceed: true }),
    ]) {
      const fetcher = (async () => completion(value)) as typeof fetch;
      await rejected(() =>
        createOpenRouterGenerator({
          apiKey: "test",
          model: "test/model",
          fetch: fetcher,
        })(input)
      );
    }
  });
  it("rejects truncated completions", async () => {
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "length",
              message: {
                content: JSON.stringify({ answer: "partial", citationIds: [] }),
              },
            },
          ],
        })
      )) as typeof fetch;
    await rejected(() =>
      createOpenRouterGenerator({
        apiKey: "test",
        model: "test/model",
        fetch: fetcher,
      })(input)
    );
  });
  it("bounds the provider response body", async () => {
    const validEnvelope = JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              answer: "Supported answer.",
              citationIds: [source.id],
            }),
          },
        },
      ],
      metadata: "x".repeat(65537),
    });
    expect(() => JSON.parse(validEnvelope)).not.to.throw();
    const fetcher = (async () => new Response(validEnvelope)) as typeof fetch;
    await rejected(() =>
      createOpenRouterGenerator({
        apiKey: "test",
        model: "test/model",
        fetch: fetcher,
      })(input)
    );
  });
});
