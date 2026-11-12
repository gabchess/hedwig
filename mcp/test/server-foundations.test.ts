import { expect } from "chai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHedwigServer, resolveKnowledgeMode } from "../src/server-core";

async function withClient(
  config: Parameters<typeof createHedwigServer>[0],
  run: (client: Client) => Promise<void>
) {
  const server = createHedwigServer(config);
  const client = new Client({ name: "foundation-fixture", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}
function content(result: any) {
  return result.structuredContent;
}
describe("foundations MCP profile (fixture generation)", () => {
  it("requires explicit profile selection and rejects unknown settings", () => {
    expect(resolveKnowledgeMode(undefined)).to.equal("seed");
    expect(resolveKnowledgeMode("foundations")).to.equal("foundations");
    expect(() => resolveKnowledgeMode("anything")).to.throw(
      "HEDWIG_KNOWLEDGE_MODE"
    );
  });
  it("retrieves natural questions and returns pinned provenance through MCP", async () => {
    let seen: string[] = [];
    await withClient(
      {
        mode: "education",
        knowledgeMode: "foundations",
        generateFoundations: async ({ sources }) => {
          seen = sources.map((s) => s.id);
          return {
            status: "answered",
            answer: "Account balance is ETH denominated in wei.",
            citationIds: ["ethereum-account-state"],
            unsupportedParts: [],
          };
        },
      },
      async (client) => {
        const listed = await client.listTools();
        expect(listed.tools[0].description).to.include("Ethereum accounts");
        const response = content(
          await client.callTool({
            name: "ask_hedwig",
            arguments: {
              question:
                "What does the balance field of an Ethereum account mean?",
            },
          })
        );
        expect(seen).to.include("ethereum-account-state");
        expect(response.status).to.equal("answered");
        expect(response.sources[0].revision).to.match(/@[a-f0-9]{40}$/);
        expect(response.sources[0].sourceFileUrl).to.include("/blob/");
      }
    );
  });
  it("preserves mixed-question limits and abstention through MCP", async () => {
    await withClient(
      {
        mode: "education",
        knowledgeMode: "foundations",
        generateFoundations: async ({ question }) =>
          question.includes("today")
            ? {
                status: "partial",
                answer:
                  "Shares represent a fractional claim on underlying holdings.",
                citationIds: ["erc4626-shares-and-assets"],
                unsupportedParts: [
                  "The named deployment safety is unsupported.",
                ],
              }
            : {
                status: "insufficient_evidence",
                answer: "",
                citationIds: [],
                unsupportedParts: ["Current yields unavailable."],
              },
      },
      async (client) => {
        const partial = content(
          await client.callTool({
            name: "ask_hedwig",
            arguments: {
              question: "Explain ERC-4626 shares and assess this vault today.",
            },
          })
        );
        expect(partial.status).to.equal("partial");
        expect(partial.unsupportedParts).to.have.length(1);
        const abstain = content(
          await client.callTool({
            name: "ask_hedwig",
            arguments: { question: "Which ERC-4626 vault has highest APY?" },
          })
        );
        expect(abstain.status).to.equal("insufficient_evidence");
        expect(abstain.answer).to.equal(undefined);
      }
    );
  });
  it("skips generation without candidates and rejects caller profile overrides", async () => {
    let calls = 0;
    await withClient(
      {
        mode: "education",
        knowledgeMode: "foundations",
        generateFoundations: async () => {
          calls++;
          throw Error("unexpected");
        },
      },
      async (client) => {
        const empty = content(
          await client.callTool({
            name: "ask_hedwig",
            arguments: { question: "quuxblargle" },
          })
        );
        expect(empty.status).to.equal("insufficient_evidence");
        const extra = content(
          await client.callTool({
            name: "ask_hedwig",
            arguments: {
              question: "Explain Ethereum accounts",
              knowledgeMode: "seed",
            },
          })
        );
        expect(extra.status).to.equal("invalid_question");
        expect(calls).to.equal(0);
      }
    );
  });
  it("reports missing model configuration as unavailable", async () => {
    await withClient(
      { mode: "education", knowledgeMode: "foundations" },
      async (client) => {
        const value = content(
          await client.callTool({
            name: "ask_hedwig",
            arguments: { question: "Explain Ethereum accounts" },
          })
        );
        expect(value.status).to.equal("unavailable");
      }
    );
  });
});
