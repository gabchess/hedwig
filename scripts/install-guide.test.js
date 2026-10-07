const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const release = "e85049bc7087f434fd732bb02e0e87ca57acd82c";
const yarn = spawnSync("which", ["yarn"], { encoding: "utf8" }).stdout.trim();
assert.ok(yarn, "Yarn must be installed for the offline lifecycle test");

function recipe(file) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const start = source.indexOf("mkdir hedwig");
  assert.ok(start >= 0, `${file} has an install recipe`);
  return source
    .slice(start)
    .split(file.endsWith(".html") ? "</code>" : "```")[0]
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .trim();
}

function runRecipe(file, checkout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hedwig-install-test-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const writeTool = (name, body) =>
      fs.writeFileSync(
        path.join(bin, name),
        `#!${process.execPath}\n${body}\n`,
        { mode: 0o700 }
      );
    // The remote boundary is replaced with a local package that has a hostile
    // lifecycle script. The documented shell and real Yarn still execute.
    writeTool(
      "git",
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      if (args[0] === 'checkout') {
        fs.writeFileSync('package.json', JSON.stringify({name:'install-fixture',version:'1.0.0',private:true,
          scripts:{postinstall:'node -e "require(\\\'fs\\\').writeFileSync(\\\'lifecycle-ran\\\', \\\'bad\\\')"'}}));
        fs.writeFileSync('yarn.lock', '# yarn lockfile v1\\n');
      }
      if (args[0] === 'rev-parse') console.log(process.env.FIXTURE_CHECKOUT);
    `
    );
    writeTool(
      "yarn",
      `
      const fs = require('node:fs');
      const {spawnSync} = require('node:child_process');
      const args = process.argv.slice(2);
      fs.appendFileSync('commands.log', JSON.stringify(['yarn', ...args])+'\\n');
      if (args[0] === 'install') {
        const result = spawnSync(${JSON.stringify(
          yarn
        )}, [...args, '--offline', '--non-interactive'], {stdio:'inherit'});
        process.exit(result.status ?? 1);
      }
    `
    );
    writeTool(
      "npm",
      `require('node:fs').appendFileSync('commands.log', JSON.stringify(['npm', ...process.argv.slice(2)])+'\\n');`
    );
    const result = spawnSync("/bin/sh", ["-c", recipe(file)], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FIXTURE_CHECKOUT: checkout,
      },
    });
    const log = path.join(dir, "hedwig", "commands.log");
    return {
      status: result.status,
      output: `${result.stdout}\n${result.stderr}`,
      lifecycleRan: fs.existsSync(path.join(dir, "hedwig", "lifecycle-ran")),
      commands: fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse)
        : [],
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const file of ["docs/agents.md", "web/agents.md", "web/docs.html"]) {
  test(`${file}: a dependency lifecycle script cannot execute`, () => {
    const result = runRecipe(file, release);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.lifecycleRan, false, "untrusted postinstall executed");
    assert.deepEqual(
      result.commands.filter(
        ([tool, command]) => tool === "yarn" && command.endsWith(":build")
      ),
      [
        ["yarn", "consult:build"],
        ["yarn", "mcp:build"],
      ]
    );
    assert.ok(
      result.commands.some(
        (command) =>
          command[0] === "npm" && command.includes("--ignore-scripts")
      )
    );
  });

  test(`${file}: checkout mismatch stops before any dependency install or build`, () => {
    const result = runRecipe(file, "0000000000000000000000000000000000000000");
    assert.notEqual(result.status, 0, "wrong checkout was accepted");
    assert.deepEqual(result.commands, []);
    assert.equal(result.lifecycleRan, false);
  });
}
