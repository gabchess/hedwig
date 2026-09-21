// Drives the built server over real stdio through a table of malformed
// wire shapes, interleaving one known-good "sanity" call after each one so
// the parent test can confirm the server is still alive and correct. Not
// run by ts-mocha: plain CommonJS, loaded by the parent test via a child
// process.
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
  getDefaultEnvironment,
} = require("@modelcontextprotocol/sdk/client/stdio.js");

const [, , serverPath, policyPath] = process.argv;

const validAction = {
  type: "pay",
  chainId: "eip155:1",
  recipient: "0x00000000000000000000000000000000a11ce001",
  asset: {
    symbol: "USDC",
    contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  amount: "1000000",
  target: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};
const SANITY_CALL = { request: { action: validAction } };

// Every row is a value for the tool call's `arguments`. `MISSING` is a
// sentinel meaning "omit the key entirely", since JSON.stringify would
// otherwise drop an explicit `undefined` the same way, making the two
// indistinguishable on the wire.
const MISSING = Symbol("missing");

const rows = [
  ["missing arguments key", MISSING],
  ["arguments: null", null],
  ["arguments: a string", "not-an-object"],
  ["arguments: a number", 42],
  ["arguments: an array", []],
  ["arguments: a boolean", true],
  ["missing request key", {}],
  ["request: null", { request: null }],
  ["request: a string", { request: "not-a-request" }],
  ["request: a number", { request: 42 }],
  ["request: an array", { request: [] }],
  [
    "an oversized array of condition ids",
    {
      request: {
        action: validAction,
        conditions: Array.from({ length: 40 }, (_, i) => `id-${i}`),
      },
    },
  ],
];

async function main() {
  const stderrChunks = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...getDefaultEnvironment(), HEDWIG_POLICY_FILE: policyPath },
    stderr: "pipe",
  });
  const client = new Client({
    name: "hedwig-mcp-wire-matrix-test",
    version: "0.0.0",
  });
  await client.connect(transport);
  transport.stderr?.on("data", (chunk) => stderrChunks.push(chunk));

  const results = [];
  for (const [label, args] of rows) {
    const params = { name: "consult" };
    if (args !== MISSING) {
      params.arguments = args;
    }

    const rowResult = await client.callTool(params);
    const sanityResult = await client.callTool({
      name: "consult",
      arguments: SANITY_CALL,
    });
    results.push({ label, rowResult, sanityResult });
  }

  // One oversized message, under the transport's own cap but over the
  // handler's 64 KB argument cap.
  const oversizedResult = await client.callTool({
    name: "consult",
    arguments: {
      request: { action: { ...validAction, memo: "x".repeat(100 * 1024) } },
    },
  });
  const oversizedSanity = await client.callTool({
    name: "consult",
    arguments: SANITY_CALL,
  });
  results.push({
    label: "oversized message under the transport cap",
    rowResult: oversizedResult,
    sanityResult: oversizedSanity,
  });

  await client.close();
  await new Promise((resolve) => setTimeout(resolve, 50));

  process.stdout.write(
    JSON.stringify({
      results,
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    })
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
