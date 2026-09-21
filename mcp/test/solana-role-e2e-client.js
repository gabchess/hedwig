// Drives the built server over real stdio for exactly one "consult" call,
// using the SDK's own Client. Not run by ts-mocha: plain CommonJS, loaded
// directly by the parent test through a child process.
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
  getDefaultEnvironment,
} = require("@modelcontextprotocol/sdk/client/stdio.js");

const [, , serverPath, policyPath, rpcUrl, feePayer] = process.argv;

const request = {
  action: {
    type: "pay",
    chainId: "eip155:1",
    recipient: "0x00000000000000000000000000000000a11ce001",
    asset: {
      symbol: "USDC",
      contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    },
    amount: "1000000",
    target: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
};

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...getDefaultEnvironment(),
      HEDWIG_POLICY_FILE: policyPath,
      HEDWIG_SOLANA_RPC_URL_DEVNET: rpcUrl,
      HEDWIG_SOLANA_FEE_PAYER_DEVNET: feePayer,
    },
  });

  const client = new Client({
    name: "hedwig-mcp-solana-e2e-test",
    version: "0.0.0",
  });
  await client.connect(transport);

  const result = await client.callTool({
    name: "consult",
    arguments: { request },
  });

  // Not part of the SDK's public API, but the simplest way for this
  // throwaway test driver to confirm the server process actually exits
  // once stdin closes, rather than trusting that closing the transport
  // implies it.
  const serverProcess = transport._process;

  await client.close();

  const serverExited = await new Promise((resolve) => {
    if (!serverProcess || serverProcess.exitCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), 3000);
    serverProcess.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  process.stdout.write(JSON.stringify({ ...result, serverExited }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
