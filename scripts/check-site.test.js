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

test("check-site fails on a caveat phrase in a package README", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-site-"));
  fs.mkdirSync(path.join(root, "web"));
  fs.mkdirSync(path.join(root, "consult"));
  fs.mkdirSync(path.join(root, "mcp"));
  fs.writeFileSync(path.join(root, "web", "index.html"), "<h1>Hedwig</h1>");
  fs.writeFileSync(
    path.join(root, "consult", "README.md"),
    "# consult\n\nThis README may describe features that are not shipped.\n"
  );
  fs.writeFileSync(
    path.join(root, "mcp", "README.md"),
    "# mcp\n\nA pending item and a prototype are fine here.\n"
  );
  const run = spawnSync("node", [script, path.join(root, "web")], {
    encoding: "utf8",
  });
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(run.status, 1);
  assert.match(
    run.stdout,
    /consult\/README\.md: banned word "This README may describe"/
  );
  assert.doesNotMatch(run.stdout, /mcp\/README\.md/);
});
