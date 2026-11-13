import { expect } from "chai";
import {
  createOpenRouterFoundationGenerator,
  createOpenRouterGenerator,
  type OpenRouterDiagnostic,
} from "../src/openrouter";
import { SUPPORTED_DEPLOYMENTS } from "../src/expert-request";

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

describe("OpenRouter serialized request-byte budget", () => {
  const requestByteLimit = 64 * 1024;
  const foundationSource = {
    ...source,
    sourceFileUrl: source.url,
    revision: "reviewed-fixture",
    title: "Reviewed fixture",
  };

  for (const purpose of ["seed", "foundations"] as const) {
    it(`admits exactly 64 KiB for ${purpose} and refuses one more byte without fetching`, async () => {
      const bodies: string[] = [];
      const diagnostics: OpenRouterDiagnostic[] = [];
      const config = {
        apiKey: "fixture-key",
        model: "openai/gpt-5.2",
        onDiagnostic: (diagnostic: OpenRouterDiagnostic) =>
          diagnostics.push(diagnostic),
        fetch: (async (_url: unknown, options: RequestInit) => {
          bodies.push(options.body as string);
          return completion(JSON.stringify({ answer: "", citationIds: [] }));
        }) as typeof fetch,
      };
      const generate =
        purpose === "seed"
          ? createOpenRouterGenerator(config)
          : createOpenRouterFoundationGenerator(config);
      const base = { question: "", sources: [foundationSource] };
      await generate(base);
      const available = requestByteLimit - Buffer.byteLength(bodies[0], "utf8");
      expect(available).to.be.greaterThan(0);
      const question = "x".repeat(available);
      await generate({ ...base, question });
      expect(Buffer.byteLength(bodies[1], "utf8")).to.equal(requestByteLimit);
      expect(
        JSON.parse(JSON.parse(bodies[1]).messages[1].content)
      ).to.deep.equal({ ...base, question });
      await rejected(() => generate({ ...base, question: question + "x" }));
      expect(bodies).to.have.length(2);
      expect(diagnostics).to.deep.equal([{ code: "request_too_large" }]);
    });
  }

  it("counts multibyte UTF-8 text rather than JavaScript characters before any fetch", async () => {
    let calls = 0;
    const diagnostics: OpenRouterDiagnostic[] = [];
    const question = "é".repeat(requestByteLimit / 2);
    expect(question.length).to.be.lessThan(requestByteLimit);
    const generate = createOpenRouterFoundationGenerator({
      apiKey: "fixture-key",
      model: "openai/gpt-5.2",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      fetch: (async () => {
        calls++;
        return completion(JSON.stringify({ answer: "", citationIds: [] }));
      }) as typeof fetch,
    });
    await rejected(() => generate({ question, sources: [foundationSource] }));
    expect(calls).to.equal(0);
    expect(diagnostics).to.deep.equal([{ code: "request_too_large" }]);
  });

  it("includes the output schema in the request limit and never truncates evidence", async () => {
    let calls = 0;
    const requestInput = {
      question: "Explain the source.",
      sources: [{ ...foundationSource, id: "s".repeat(32_000) }],
    };
    const original = structuredClone(requestInput);
    expect(
      Buffer.byteLength(JSON.stringify(requestInput), "utf8")
    ).to.be.lessThan(requestByteLimit);
    const diagnostics: OpenRouterDiagnostic[] = [];
    const generate = createOpenRouterFoundationGenerator({
      apiKey: "fixture-key",
      model: "openai/gpt-5.2",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      fetch: (async () => {
        calls++;
        return completion(JSON.stringify({ answer: "", citationIds: [] }));
      }) as typeof fetch,
    });
    await rejected(() => generate(requestInput));
    expect(calls).to.equal(0);
    expect(requestInput).to.deep.equal(original);
    expect(diagnostics).to.deep.equal([{ code: "request_too_large" }]);
  });
});

describe("OpenRouter answer adapter (fixture transport, no live inference)", () => {
  for (const purpose of ["seed", "foundations"] as const) {
    it(`uses only exact DeepSeek Flash selections with high reasoning without changing ${purpose} evidence or output schema`, async () => {
      const bodies: any[] = [];
      const retrievedInput = {
        question: input.question,
        sources: [
          {
            ...source,
            sourceFileUrl: source.url,
            revision: "reviewed-fixture",
            title: "Reviewed fixture",
          },
        ],
      };
      for (const model of [
        "test/model",
        "deepseek/deepseek-v4-flash-0731",
        "deepseek/deepseek-v4.1-flash-1017",
        "deepseek/deepseek-v4-flash-0731:free",
        "deepseek/deepseek-v4-flash-20260731",
        "deepseek/deepseek-v4.1-flash-1017:free",
        "deepseek/deepseek-v4.1-flash-20261017",
      ]) {
        const config = {
          apiKey: "fixture",
          model,
          fetch: (async (_url: unknown, options: RequestInit) => {
            bodies.push(JSON.parse(options.body as string));
            return completion(
              JSON.stringify({
                answer: "",
                citationIds: [],
                ...(purpose === "foundations" ? { unsupportedParts: [] } : {}),
              })
            );
          }) as typeof fetch,
        };
        await (purpose === "seed"
          ? createOpenRouterGenerator(config)
          : createOpenRouterFoundationGenerator(config))(retrievedInput);
      }
      const [ordinary, ...selectedAndAliases] = bodies;
      for (const deepseek of selectedAndAliases.slice(0, 2)) {
        expect(deepseek).to.include({
          stream: false,
          max_tokens: 8192,
        });
        expect(deepseek.reasoning).to.deep.equal({
          effort: "high",
          exclude: true,
        });
        expect(deepseek).not.to.have.property("temperature");
        expect(deepseek.provider).to.deep.equal({
          data_collection: "deny",
          require_parameters: true,
          allow_fallbacks: false,
          zdr: true,
        });
        expect(deepseek.messages).to.deep.equal(ordinary.messages);
        expect(JSON.parse(deepseek.messages[1].content)).to.deep.equal(
          retrievedInput
        );
        expect(deepseek.response_format).to.deep.equal(
          ordinary.response_format
        );
      }
      expect(
        selectedAndAliases.slice(0, 2).map((body) => body.model)
      ).to.deep.equal([
        "deepseek/deepseek-v4-flash-0731",
        "deepseek/deepseek-v4.1-flash-1017",
      ]);
      for (const body of [ordinary, ...selectedAndAliases.slice(2)]) {
        expect(body).to.include({
          temperature: 0,
          max_tokens: purpose === "seed" ? 1024 : 2048,
        });
        expect(body).not.to.have.property("reasoning");
      }
    });
  }
  for (const purpose of ["seed", "foundations"] as const) {
    it(`sorts only exact Qwen requests by throughput while preserving ${purpose} evidence, schema and limits`, async () => {
      const bodies: any[] = [];
      const retrievedInput = {
        question: input.question,
        sources: [
          {
            ...source,
            sourceFileUrl: source.url,
            revision: "reviewed-fixture",
            title: "Reviewed fixture",
          },
        ],
      };
      for (const model of [
        "test/model",
        "qwen/qwen3-235b-a22b-2507",
        "qwen/qwen3-235b-a22b-2507:free",
        "qwen/qwen3-235b-a22b-07-25",
      ]) {
        const config = {
          apiKey: "fixture",
          model,
          fetch: (async (_url: unknown, options: RequestInit) => {
            bodies.push(JSON.parse(options.body as string));
            return completion(
              JSON.stringify({
                answer: "",
                citationIds: [],
                ...(purpose === "foundations" ? { unsupportedParts: [] } : {}),
              })
            );
          }) as typeof fetch,
        };
        const generate =
          purpose === "seed"
            ? createOpenRouterGenerator(config)
            : createOpenRouterFoundationGenerator(config);
        await generate(retrievedInput);
      }
      const [ordinary, qwen, freeVariant, canonicalAlias] = bodies;
      expect(qwen).to.include({
        model: "qwen/qwen3-235b-a22b-2507",
        stream: false,
        temperature: 0,
        max_tokens: purpose === "seed" ? 1024 : 2048,
      });
      expect(qwen).not.to.have.property("reasoning");
      expect(qwen.provider).to.deep.equal({
        data_collection: "deny",
        require_parameters: true,
        allow_fallbacks: false,
        zdr: true,
        sort: "throughput",
      });
      expect(qwen.messages).to.deep.equal(ordinary.messages);
      expect(JSON.parse(qwen.messages[1].content)).to.deep.equal(
        retrievedInput
      );
      expect(qwen.response_format).to.deep.equal(ordinary.response_format);
      for (const body of [ordinary, freeVariant, canonicalAlias])
        expect(body.provider).not.to.have.property("sort");
    });
  }
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
    expect(body.max_tokens).to.equal(1024);
    expect(body.temperature).to.equal(0);
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

describe("OpenRouter foundation answer adapter (fixture transport, no live inference)", () => {
  const foundationSource = {
    id: "erc4626-operations",
    url: "https://eips.ethereum.org/EIPS/eip-4626",
    sourceFileUrl:
      "https://github.com/ethereum/ERCs/blob/cf8bff877b00d56cec0c60007a25bae0937d0d03/ERCS/erc-4626.md",
    revision: "ethereum/ERCs@cf8bff877b00d56cec0c60007a25bae0937d0d03",
    title: "ERC-4626: Tokenized Vaults",
    text: "deposit fixes assets; mint fixes shares.",
  };
  const foundationInput = {
    question: "Explain deposit versus mint and give current yield.",
    sources: [foundationSource],
  };

  it("requires exactly the trusted comparison identities with separately scoped citation choices", async () => {
    const [left, right] = SUPPORTED_DEPLOYMENTS.map(
      (deployment) => deployment.id
    );
    const generated = {
      sections: {
        [left]: {
          requested: true,
          answer: "Left fact.",
          citationIds: ["opaque-left"],
          unsupportedParts: [],
        },
        [right]: {
          requested: true,
          answer: "Right fact.",
          citationIds: ["opaque-right"],
          unsupportedParts: [],
        },
      },
    };
    let sent: any;
    let calls = 0;
    const comparison = {
      deployments: SUPPORTED_DEPLOYMENTS,
      liveStateVerified: false as const,
      limitation: "No current observation.",
      evidence: {
        byDeployment: { [left]: ["opaque-left"], [right]: ["opaque-right"] },
        sharedSourceIds: ["shared"],
      },
    };
    const requestInput = {
      question: "Compare each requested mechanism.",
      sources: ["opaque-left", "opaque-right", "shared"].map((id) => ({
        ...foundationSource,
        id,
      })),
      comparison,
    };
    const result = await createOpenRouterFoundationGenerator({
      apiKey: "test",
      model: "test/model",
      fetch: (async (_url: unknown, options: RequestInit) => {
        calls++;
        sent = JSON.parse(options.body as string);
        return completion(JSON.stringify(generated));
      }) as typeof fetch,
    })(requestInput);
    expect(result).to.deep.equal(generated);
    expect(calls).to.equal(1);
    const schema = sent.response_format.json_schema.schema;
    expect(sent.response_format.json_schema.name).to.equal(
      "hedwig_comparison_answer"
    );
    expect(schema.required).to.deep.equal(["sections"]);
    expect(schema.additionalProperties).to.equal(false);
    expect(schema.properties.sections.required).to.deep.equal([left, right]);
    expect(schema.properties.sections.additionalProperties).to.equal(false);
    for (const [id, sourceId] of [
      [left, "opaque-left"],
      [right, "opaque-right"],
    ]) {
      const section = schema.properties.sections.properties[id];
      expect(section.required).to.deep.equal([
        "requested",
        "answer",
        "citationIds",
        "unsupportedParts",
      ]);
      expect(section.additionalProperties).to.equal(false);
      expect(section.properties.requested).to.deep.equal({ type: "boolean" });
      expect(section.properties.citationIds.items.enum).to.deep.equal([
        sourceId,
        "shared",
      ]);
    }
    expect(JSON.parse(sent.messages[1].content)).to.deep.equal(requestInput);
    expect(sent.messages[0].content).to.contain(
      "Preserve which deployment each requested factual part concerns."
    );
    expect(sent.messages[0].content).to.contain(
      "Set requested=false only when the question requests neither a factual answer nor a concrete action concerning that deployment."
    );
    expect(sent.messages[0].content).to.contain(
      "An evidence gap does not make a requested deployment unrequested."
    );
    expect(sent.messages[0].content).to.contain(
      "A request for transaction approval or execution requires requested=true with its unsupported action recorded as a gap."
    );
    expect(sent.messages[0].content).to.contain(
      "Do not present reviewed paraphrases as verbatim quotations"
    );
  });

  it("requests only content, citations and gaps for downstream classification", async () => {
    const generated = {
      answer: "deposit fixes assets; mint fixes shares.",
      citationIds: [foundationSource.id],
      unsupportedParts: ["current yield"],
    };
    let request: RequestInit | undefined;
    let url = "";
    let calls = 0;
    const fetcher = (async (u: unknown, opts: RequestInit) => {
      calls++;
      url = String(u);
      request = opts;
      return completion(JSON.stringify(generated));
    }) as typeof fetch;

    const generate = createOpenRouterFoundationGenerator({
      apiKey: "test-key",
      model: "test/model:free",
      fetch: fetcher,
    });

    expect(await generate(foundationInput)).to.deep.equal(generated);
    expect(calls).to.equal(1);
    expect(url).to.equal("https://openrouter.ai/api/v1/chat/completions");
    expect(request!.redirect).to.equal("error");
    expect(request!.signal).to.be.instanceOf(AbortSignal);
    expect((request!.headers as Record<string, string>).Authorization).to.equal(
      "Bearer test-key"
    );

    const body = JSON.parse(request!.body as string);
    expect(body.model).to.equal("test/model:free");
    expect(body.max_tokens).to.equal(2048);
    expect(body.temperature).to.equal(0);
    expect(body.models).to.equal(undefined);
    expect(body.tools).to.equal(undefined);
    expect(body.provider).to.deep.equal({
      data_collection: "deny",
      require_parameters: true,
      allow_fallbacks: false,
    });
    expect(body.response_format).to.deep.equal({
      type: "json_schema",
      json_schema: {
        name: "hedwig_foundation_answer",
        strict: true,
        schema: {
          type: "object",
          properties: {
            answer: { type: "string" },
            citationIds: {
              type: "array",
              items: { type: "string", enum: [foundationSource.id] },
            },
            unsupportedParts: { type: "array", items: { type: "string" } },
          },
          required: ["answer", "citationIds", "unsupportedParts"],
          additionalProperties: false,
        },
      },
    });

    const systemPrompt = body.messages[0].content as string;
    expect(systemPrompt).to.contain("only the supplied retrieved evidence");
    expect(systemPrompt).to.contain(
      "Omit adjacent topics and details unless needed to answer that part."
    );
    expect(systemPrompt).to.contain(
      "Every assertion, including explanatory additions, must be supported by supplied text."
    );
    expect(systemPrompt).to.contain("partially supported");
    expect(systemPrompt).not.to.contain("Set status");
    expect(systemPrompt).to.contain("current chain state");
    expect(systemPrompt).to.contain("deposit safety");
    expect(JSON.parse(body.messages[1].content)).to.deep.equal(foundationInput);
  });

  it("binds citation choices independently to each request's retrieved evidence", async () => {
    const allowed: string[][] = [];
    const generate = createOpenRouterFoundationGenerator({
      apiKey: "test",
      model: "test/model",
      fetch: (async (_url: unknown, request: RequestInit) => {
        const body = JSON.parse(request.body as string);
        allowed.push(
          body.response_format.json_schema.schema.properties.citationIds.items
            .enum
        );
        return completion(
          JSON.stringify({ answer: "", citationIds: [], unsupportedParts: [] })
        );
      }) as typeof fetch,
    });
    await generate(foundationInput);
    await generate({
      ...foundationInput,
      sources: [{ ...foundationSource, id: "different-source" }],
    });
    expect(allowed).to.deep.equal([
      [foundationSource.id],
      ["different-source"],
    ]);
  });

  it("uses the explicitly selected reasoning model's bounded profile without temperature", async () => {
    let request: Record<string, unknown> | undefined;
    const generate = createOpenRouterFoundationGenerator({
      apiKey: "test",
      model: "openai/gpt-5.1",
      fetch: (async (_url: unknown, options: RequestInit) => {
        request = JSON.parse(options.body as string);
        return completion(
          JSON.stringify({ answer: "", citationIds: [], unsupportedParts: [] })
        );
      }) as typeof fetch,
    });
    await generate(foundationInput);
    expect(request).to.include({
      model: "openai/gpt-5.1",
      max_tokens: 4096,
      stream: false,
    });
    expect(request).not.to.have.property("temperature");
    expect(request?.reasoning).to.deep.equal({ effort: "low", exclude: true });
    expect(request?.provider).to.deep.equal({
      data_collection: "deny",
      require_parameters: true,
      allow_fallbacks: false,
      zdr: true,
    });
  });

  it("rejects truncated foundation completions", async () => {
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "length",
              message: {
                content: JSON.stringify({
                  answer: "Supported part.",
                  citationIds: [foundationSource.id],
                  unsupportedParts: ["current yield"],
                }),
              },
            },
          ],
        })
      )) as typeof fetch;
    await rejected(() =>
      createOpenRouterFoundationGenerator({
        apiKey: "test",
        model: "test/model",
        fetch: fetcher,
      })(foundationInput)
    );
  });
});
