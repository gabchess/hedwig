const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.join(__dirname, "check-site.js");

test("check-site fails on caveat phrases in a page and the README", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-site-"));
  fs.mkdirSync(path.join(root, "web"));
  fs.writeFileSync(
    path.join(root, "web", "index.html"),
    "<h1>Hedwig</h1><p>Hedwig is in development.</p>"
  );
  fs.writeFileSync(
    path.join(root, "README.md"),
    "# Hedwig\n\nThis README may describe features that are pending.\n"
  );
  const run = spawnSync("node", [script, path.join(root, "web")], {
    encoding: "utf8",
  });
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /index\.html: banned word "in development"/);
  assert.match(
    run.stdout,
    /README\.md: banned word "This README may describe"/
  );
});

test("check-site scans every public text file, with a small allowlist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-site-"));
  for (const d of ["web", "consult", "mcp", "docs", "plugin"])
    fs.mkdirSync(path.join(root, d));
  const put = (f, s) => fs.writeFileSync(path.join(root, f), s);
  put("web/index.html", "<h1>Hedwig</h1>");
  put("consult/README.md", "# consult\n\nThis README may describe more.\n");
  put("mcp/README.md", "# mcp\n\nA pending item and a prototype.\n");
  put("docs/agents.md", "# Agents\n\nHosted reports are in development.\n");
  put("SECURITY.md", "Never post a working proof of concept in an issue.\n");
  put("plugin/THIRD-PARTY-NOTICES.md", "without limitation the rights\n");
  const run = spawnSync("node", [script, path.join(root, "web")], {
    encoding: "utf8",
  });
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /consult\/README\.md: banned word/);
  assert.match(run.stdout, /mcp\/README\.md: banned word "pending"/);
  assert.match(run.stdout, /docs\/agents\.md: banned word "in development"/);
  assert.doesNotMatch(run.stdout, /SECURITY|THIRD-PARTY/);
});
