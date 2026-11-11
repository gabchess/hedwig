import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { pinPolicyFile } from "../src/policy";
import { createHedwigServer, resolveHedwigMode } from "../src/server-core";
import type { GenerateAnswer } from "../src/expert";

const VALID_POLICY = {
  permits: true,
  chainId: "eip155:1",
  approvedRecipients: ["0x00000000000000000000000000000000a11ce001"],
  perActionCaps: { pay: "1000000" },
  perActionCapAssets: { pay: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  role: { mode: "not-required" },
  authorizationWindow: { mode: "not-required" },
};

function structuredContent(result: unknown) {
  if (
    result === null ||
    typeof result !== "object" ||
    !("structuredContent" in result)
  ) {
    return undefined;
  }
  const value = (result as { structuredContent?: unknown }).structuredContent;
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

const VALID_REQUEST = JSON.parse(
  readFileSync(
    join(process.cwd(), "mcp", "test", "fixtures", "request.json"),
    "utf8"
  )
);

async function withClient<T>(
  config: Parameters<typeof createHedwigServer>[0],
  run: (client: Client) => Promise<T>
): Promise<T> {
  const server = createHedwigServer(config);
  const client = new Client({ name: "hedwig-mode-test", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("education MCP mode", () => {
  it("resolves only consult by default and accepts the explicit modes", () => {
    expect(resolveHedwigMode(undefined)).to.equal("consult");
    expect(resolveHedwigMode("consult")).to.equal("consult");
    expect(resolveHedwigMode("education")).to.equal("education");
    expect(resolveHedwigMode("both")).to.equal("both");
    expect(() => resolveHedwigMode("learn")).to.throw("HEDWIG_MODE");
    expect(() => resolveHedwigMode("unknown")).to.throw("HEDWIG_MODE");
    expect(() => createHedwigServer({ mode: "both" })).to.throw(
      "pinned policy file"
    );
  });

  it("exposes only ask_hedwig with the bounded question-only schema", async () => {
    const result = await withClient({ mode: "education" }, (client) =>
      client.listTools()
    );
    expect(result.tools.map(({ name }) => name)).to.deep.equal(["ask_hedwig"]);
    expect(result.tools[0].inputSchema).to.deep.equal({
      type: "object",
      properties: { question: { type: "string", maxLength: 4000 } },
      required: ["question"],
      additionalProperties: false,
    });
  });

  it("answers an admitted question through MCP using an injected fixture generator", async () => {
    const calls: string[] = [];
    const generate: GenerateAnswer = async ({ question, sources }) => {
      calls.push(question);
      return { answer: "Fixture answer.", citationIds: [sources[0].id] };
    };

    const response = await withClient(
      { mode: "education", generate },
      (client) =>
        client.callTool({
          name: "ask_hedwig",
          arguments: { question: "What are ERC-4626 vault shares?" },
        })
    );
    expect(calls).to.deep.equal(["What are ERC-4626 vault shares?"]);
    expect(response.isError).to.equal(false);
    expect(structuredContent(response)).to.include({ status: "answered" });
    expect(structuredContent(response)?.answer).to.equal("Fixture answer.");
    expect(structuredContent(response)?.sources).to.deep.equal([
      {
        id: "erc4626-shares",
        url: "https://eips.ethereum.org/EIPS/eip-4626#specification",
      },
    ]);
  });

  it("rejects unsupported and extra-argument calls before generator invocation", async () => {
    let calls = 0;
    const generate: GenerateAnswer = async () => {
      calls += 1;
      return { answer: "Fixture answer.", citationIds: ["erc4626-shares"] };
    };

    const results = await withClient(
      { mode: "education", generate },
      async (client) => {
        const unsupported = await client.callTool({
          name: "ask_hedwig",
          arguments: {
            question: "What is the current live yield of this vault?",
          },
        });
        const extra = await client.callTool({
          name: "ask_hedwig",
          arguments: {
            question: "What are ERC-4626 vault shares?",
            apiKey: "CANARY-EXTRA-ARGUMENT",
          },
        });
        const oversized = await client.callTool({
          name: "ask_hedwig",
          arguments: { question: "x".repeat(4001) },
        });
        return { unsupported, extra, oversized };
      }
    );

    expect(structuredContent(results.unsupported)).to.include({
      status: "insufficient_evidence",
    });
    expect(structuredContent(results.extra)).to.include({
      status: "invalid_question",
    });
    expect(structuredContent(results.oversized)).to.include({
      status: "invalid_question",
    });
    expect(calls).to.equal(0);
  });

  it("returns unavailable for admitted questions when no generator is configured", async () => {
    const results = await withClient({ mode: "education" }, async (client) => {
      const supported = await client.callTool({
        name: "ask_hedwig",
        arguments: { question: "What are ERC-4626 vault shares?" },
      });
      const unsupported = await client.callTool({
        name: "ask_hedwig",
        arguments: { question: "What is the live yield today?" },
      });
      return { supported, unsupported };
    });
    expect(structuredContent(results.supported)).to.include({
      status: "unavailable",
    });
    expect(structuredContent(results.supported)?.answer).to.equal(undefined);
    expect(structuredContent(results.unsupported)).to.include({
      status: "insufficient_evidence",
    });
  });

  it("keeps consult in default mode and exposes both tools in combined mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hedwig-modes-"));
    try {
      const policyPath = join(dir, "policy.json");
      writeFileSync(policyPath, JSON.stringify(VALID_POLICY));
      const policyPin = pinPolicyFile(policyPath);
      const configs = [
        { mode: "consult" as const, policyPath, policyPin },
        { mode: "both" as const, policyPath, policyPin },
      ];
      for (const config of configs) {
        const result = await withClient(config, async (client) => {
          const tools = await client.listTools();
          const consult = await client.callTool({
            name: "consult",
            arguments: { request: VALID_REQUEST },
          });
          return { names: tools.tools.map(({ name }) => name), consult };
        });
        expect(result.names).to.deep.equal(
          config.mode === "consult" ? ["consult"] : ["consult", "ask_hedwig"]
        );
        expect(structuredContent(result.consult)?.verdict).to.equal(
          "ALLOW_UNDER_POLICY"
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
