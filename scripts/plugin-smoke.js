// Starts the bundled server the way plugin/.mcp.json starts it, with only
// PATH and CLAUDE_PLUGIN_ROOT set, then does an MCP handshake and four
// consult calls. Exits 1 on any mismatch. No dependencies.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pluginRoot = path.join(root, "plugin");

// Expand ${VAR} and ${VAR:-default} the way the .mcp.json fields use them.
function expand(text, env) {
  const token = /\$\{([A-Z_]+)(?::-([^${}]*))?\}/;
  let out = text;
  for (let i = 0; i < 10 && token.test(out); i++) {
    out = out.replace(
      token,
      (_, name, fallback) => env[name] || fallback || ""
    );
  }
  return out;
}

const env = { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: pluginRoot };
const entry = JSON.parse(
  fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")
).mcpServers.hedwig;
const childEnv = { PATH: env.PATH, CLAUDE_PLUGIN_ROOT: pluginRoot };
for (const [key, value] of Object.entries(entry.env || {}))
  childEnv[key] = expand(value, env);
const args = entry.args.map((arg) => expand(arg, env));

const skill = fs.readFileSync(
  path.join(pluginRoot, "skills/ask/SKILL.md"),
  "utf8"
);
const skillRequest = JSON.parse(
  /```json\n([\s\S]*?)\n```/.exec(skill)[1]
).request;
const fixture = JSON.parse(
  fs.readFileSync(path.join(root, "mcp/test/fixtures/request.json"), "utf8")
);

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const LOOKALIKE = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606dEAD";
const RECIPIENT = fixture.action.recipient;

function transferData(recipient, amount) {
  const to = recipient.slice(2).toLowerCase().padStart(64, "0");
  return "0xa9059cbb" + to + BigInt(amount).toString(16).padStart(64, "0");
}

const over = structuredClone(fixture);
over.action.amount = "50000000";
over.transaction.data = transferData(RECIPIENT, "50000000");

const fake = structuredClone(fixture);
fake.action.asset.contractAddress = LOOKALIKE;
fake.action.target = LOOKALIKE;
fake.transaction.to = LOOKALIKE;

const cases = [
  { name: "skill example", request: skillRequest, proceed: true },
  {
    name: "50 USDC",
    request: over,
    proceed: false,
    code: "AMOUNT_EXCEEDS_CAP",
  },
  {
    name: "lookalike token",
    request: fake,
    proceed: false,
    code: "ASSET_NOT_CANONICAL",
  },
  { name: "fixture", request: fixture, proceed: true },
];

const child = spawn(entry.command, args, {
  env: childEnv,
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));
const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id))
      pending.get(message.id)(message);
  }
});

let nextId = 1;
function rpc(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
    );
  });
}

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

const timer = setTimeout(() => {
  console.error("FAIL timeout waiting for the server");
  child.kill();
  process.exit(1);
}, 30000);

async function main() {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "plugin-smoke", version: "0" },
  });
  check(
    "handshake",
    Boolean(init.result && init.result.serverInfo),
    JSON.stringify(init)
  );
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }) + "\n"
  );

  const listed = await rpc("tools/list", {});
  const names = (listed.result?.tools || []).map((tool) => tool.name);
  check(
    "tools/list is exactly consult",
    names.length === 1 && names[0] === "consult",
    names.join(",")
  );

  for (const item of cases) {
    const reply = await rpc("tools/call", {
      name: "consult",
      arguments: { request: item.request },
    });
    const result = reply.result?.structuredContent;
    if (!result) {
      check(item.name, false, JSON.stringify(reply));
      continue;
    }
    const first = result.results.find((row) => row.status !== "PASS");
    const rowsOk = item.proceed
      ? result.results.length === 12 && !first
      : first && first.code === item.code;
    check(
      `${item.name}: ${item.proceed ? "go" : "no"}${
        item.code ? " " + item.code : ""
      }`,
      result.proceed === item.proceed && Boolean(rowsOk),
      JSON.stringify({
        proceed: result.proceed,
        verdict: result.verdict,
        first,
      })
    );
  }
}

main()
  .catch((error) => failures.push(String(error)))
  .finally(() => {
    clearTimeout(timer);
    child.stdin.end();
    if (failures.length) {
      console.error(failures.join("\n"));
      if (stderr.trim()) console.error("server stderr:", stderr.trim());
      process.exit(1);
    }
  });
