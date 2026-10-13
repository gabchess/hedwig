const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Needs `yarn consult:build` first, as CI does.
const { consult } = require("../consult/dist");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function jsonBlocks(file) {
  return [...read(file).matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) =>
    JSON.parse(m[1])
  );
}

function pick(file, key) {
  const found = jsonBlocks(file).filter((block) => key in block);
  assert.equal(found.length, 1, `${file} has one json block with "${key}"`);
  return found[0];
}

const policy = pick("docs/agents.md", "perActionCaps");
const requests = {
  "docs/agents.md": pick("docs/agents.md", "request").request,
  "web/agents.md": pick("web/agents.md", "request").request,
};

// The MCP server supplies the clock and nothing else for a pay whose policy
// needs no Solana role and whose asset is built in.
const facts = () => ({ now: Math.floor(Date.now() / 1000) });

for (const [file, request] of Object.entries(requests)) {
  test(`${file} example request is allowed by the example policy`, () => {
    const response = consult(request, policy, facts());
    assert.equal(response.proceed, true, JSON.stringify(response.results));
    assert.equal(response.verdict, "ALLOW_UNDER_POLICY");
  });

  test(`${file} example without transaction is not allowed`, () => {
    const { transaction, ...rest } = request;
    assert.ok(transaction, `${file} example carries a transaction`);
    const response = consult(rest, policy, facts());
    assert.equal(response.proceed, false);
    assert.notEqual(response.verdict, "ALLOW_UNDER_POLICY");
  });
}

test("web/agents.md Step 1 names every key of the docs example policy", () => {
  const web = read("web/agents.md");
  const step1 = web.slice(web.indexOf("## Step 1"), web.indexOf("## Step 2"));
  assert.ok(step1.length > 0, "web/agents.md has Step 1");
  for (const key of Object.keys(policy)) {
    assert.ok(
      step1.includes(`- \`${key}\``),
      `web/agents.md Step 1 has a bullet for \`${key}\``
    );
  }
});
