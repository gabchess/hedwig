// Uses the pinned MCP SDK client over a real child-process stdio transport.
// Test mode clears all model and policy settings; it never sends a model call.
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
  getDefaultEnvironment,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
const { isolatedServerEnvironment } = require("./isolated-env.js");

const [, , serverPath, knowledgeMode = "seed"] = process.argv;

async function main() {
  const env = isolatedServerEnvironment(getDefaultEnvironment(), "education");
  delete env.HEDWIG_POLICY_FILE;
  env.HEDWIG_KNOWLEDGE_MODE = knowledgeMode;

  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderr.push(chunk));
  const client = new Client({ name: "hedwig-education-e2e", version: "0.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  const supported = await client.callTool({
    name: "ask_hedwig",
    arguments: {
      question:
        knowledgeMode === "foundations"
          ? "What does the balance field of an Ethereum account mean?"
          : "What are ERC-4626 vault shares?",
    },
  });
  const unsupported = await client.callTool({
    name: "ask_hedwig",
    arguments: { question: "What is the live yield today?" },
  });
  const extra = await client.callTool({
    name: "ask_hedwig",
    arguments: {
      question: "What are ERC-4626 vault shares?",
      apiKey: "CANARY-EXTRA-ARGUMENT",
    },
  });
  await client.close();
  await new Promise((resolve) => setTimeout(resolve, 50));

  process.stdout.write(
    JSON.stringify({
      tools: tools.tools,
      supported,
      unsupported,
      extra,
      stderr: Buffer.concat(stderr).toString("utf8"),
    })
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
