// Drives the built server over real stdio: one consult, then the named
// change to the policy file, then a second consult on the same server
// process. With a seventh argument of "beforeFirst" the change comes right
// after the connection is up and before the first consult. Returns both results and everything the server wrote to stderr.
// Not run by ts-mocha: plain CommonJS, loaded by the parent test via a
// child process.
const {
  copyFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
  getDefaultEnvironment,
} = require("@modelcontextprotocol/sdk/client/stdio.js");

const [, , serverPath, policyPath, mode, replacementPath, when] = process.argv;

const request = {
  transaction: require("./fixtures/request.json").transaction,
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

function mutate() {
  if (mode === "none") return;
  if (mode === "edit") {
    copyFileSync(replacementPath, policyPath);
  } else if (mode === "delete") {
    unlinkSync(policyPath);
  } else if (mode === "symlink") {
    unlinkSync(policyPath);
    symlinkSync(replacementPath, policyPath);
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
}

async function main() {
  const stderrChunks = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...getDefaultEnvironment(), HEDWIG_POLICY_FILE: policyPath },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderrChunks.push(chunk));
  const client = new Client({
    name: "hedwig-mcp-policy-pin-test",
    version: "0.0.0",
  });
  await client.connect(transport);

  if (when === "beforeFirst") mutate();
  const before = await client.callTool({
    name: "consult",
    arguments: { request },
  });
  if (when !== "beforeFirst") mutate();
  const after = await client.callTool({
    name: "consult",
    arguments: { request },
  });

  await client.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.stdout.write(
    JSON.stringify({
      ok: true,
      before: before.structuredContent,
      after: after.structuredContent,
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    })
  );
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
