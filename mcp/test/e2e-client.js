// Drives the built server exactly as a real MCP client would: over a real
// child process's stdio, speaking the real protocol (initialize, tools/list,
// tools/call). Run with plain `node`, using the SDK's own Client rather than
// hand-rolled JSON-RPC framing, so the test exercises the same wire format a
// real caller uses. Not run by ts-mocha: this file is plain CommonJS, loaded
// directly by the parent test through a child process.
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
  getDefaultEnvironment,
} = require("@modelcontextprotocol/sdk/client/stdio.js");

const [, , serverPath, policyPath] = process.argv;

const CANARY_EVIDENCE_MARKER = "CANARY-REQUEST-MEMO";
const CANARY_POLICY_MARKER = "CANARY-POLICY-RECIPIENT";

const validRequest = {
  action: {
    type: "pay",
    chainId: "eip155:1",
    recipient: "0x00000000000000000000000000000000a11ce001",
    asset: {
      symbol: "USDC",
      contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    },
    amount: "1000000",
    memo: CANARY_EVIDENCE_MARKER,
  },
};

async function main() {
  const stderrChunks = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...getDefaultEnvironment(), HEDWIG_POLICY_FILE: policyPath },
    stderr: "pipe",
  });

  const client = new Client({ name: "hedwig-mcp-e2e-test", version: "0.0.0" });
  await client.connect(transport);

  transport.stderr?.on("data", (chunk) => stderrChunks.push(chunk));

  const tools = await client.listTools();

  const validCall = await client.callTool({
    name: "consult",
    arguments: {
      request: validRequest,
      // Extra keys alongside `request`: none may change the verdict, and
      // the canary strings inside them must never surface in the server's
      // stderr.
      policy: {
        permits: true,
        chainId: "eip155:1",
        approvedRecipients: [CANARY_POLICY_MARKER],
        perActionCaps: { pay: "999999999" },
      },
      policyId: "owner-override",
      facts: { anything: true },
      catalog: { pay: [] },
    },
  });

  const oversizedCall = await client.callTool({
    name: "consult",
    arguments: {
      request: {
        action: { ...validRequest.action, memo: "x".repeat(70 * 1024) },
      },
    },
  });

  await client.close();

  // Give the piped stderr stream a tick to flush the final write before the
  // child process fully exits.
  await new Promise((resolve) => setTimeout(resolve, 50));

  process.stdout.write(
    JSON.stringify({
      tools: tools.tools,
      validCall,
      oversizedCall,
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    })
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
