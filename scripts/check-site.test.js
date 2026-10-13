const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.join(__dirname, "check-site.js");
const site = path.join(__dirname, "..", "web");

// A copy of the real site, so a run fails only on what the test adds.
function check(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-site-"));
  try {
    fs.cpSync(site, path.join(root, "web"), { recursive: true });
    for (const [f, s] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), s);
    }
    return spawnSync("node", [script, path.join(root, "web")], {
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("check-site passes on the real site with a clean tree", () => {
  const run = check({
    "SECURITY.md": "Never post a working proof of concept in an issue.\n",
    "plugin/THIRD-PARTY-NOTICES.md": "without limitation the rights\n",
  });
  assert.equal(run.status, 0, run.stdout);
});

test("check-site fails on caveat phrases in pages and the README", () => {
  const run = check({
    "web/team.html": "<h1>Hedwig</h1><p>Hedwig is in development.</p>",
    "README.md": "# Hedwig\n\nThis README may describe features.\n",
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /team\.html: banned word "in development"/);
  assert.match(run.stdout, /README\.md: banned word "This README may/);
});

test("check-site scans every public text file and manifest", () => {
  const run = check({
    "consult/README.md": "# consult\n\nSee the caveats.\n",
    "mcp/README.md": "# mcp\n\nA pending item.\n",
    "docs/agents.md": "# Agents\n\nHosted reports are in development.\n",
    "web/notes.md": "A prototype.\n",
    "web/notes.txt": "Status: `unreleased`\n",
    [`plugin/.cl${"aude"}-plugin/plugin.json`]: JSON.stringify({
      name: "hedwig",
      description: "A synthetic demo.",
    }),
  });
  assert.equal(run.status, 1);
  for (const line of [
    /consult\/README\.md: banned word "caveats"/,
    /mcp\/README\.md: banned word "pending"/,
    /docs\/agents\.md: banned word "in development"/,
    /web\/notes\.md: banned word "prototype"/,
    /web\/notes\.txt: banned word "unreleased"/,
    /plugin\.json: banned word "synthetic"/,
  ])
    assert.match(run.stdout, line);
});
