// Drives the built server over real stdio against a policy path that is
// deliberately not a small regular file (a directory, a FIFO, an oversized
// file, a missing path). Calls twice, back to back, so the parent test can
// confirm the server survives the first defective read and keeps serving.
// Not run by ts-mocha: plain CommonJS, loaded by the parent test via a
// child process.
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
  getDefaultEnvironment,
} = require("@modelcontextprotocol/sdk/client/stdio.js");

const [, , serverPath, policyPath] = process.argv;

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
    target: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
};

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms: ${label}`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...getDefaultEnvironment(), HEDWIG_POLICY_FILE: policyPath },
  });
  const client = new Client({
    name: "hedwig-mcp-policy-defect-test",
    version: "0.0.0",
  });

  await withTimeout(client.connect(transport), 5000, "connect");

  const calls = [];
  for (let i = 0; i < 2; i += 1) {
    const startedAt = Date.now();
    const result = await withTimeout(
      client.callTool({
        name: "consult",
        arguments: { request: validRequest },
      }),
      5000,
      `call ${i}`
    );
    calls.push({ elapsedMs: Date.now() - startedAt, result });
  }

  await client.close();
  process.stdout.write(JSON.stringify({ ok: true, calls }));
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: (error && error.message) || String(error),
    })
  );
  process.exit(1);
});
