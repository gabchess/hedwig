const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const release = "e85049bc7087f434fd732bb02e0e87ca57acd82c";
const yarn = spawnSync("which", ["yarn"], { encoding: "utf8" }).stdout.trim();
const npm = spawnSync("which", ["npm"], { encoding: "utf8" }).stdout.trim();
assert.ok(yarn, "Yarn must be installed for the offline lifecycle test");
assert.ok(npm, "npm must be installed for the offline lifecycle test");

function reportWarnings(context, output) {
  for (const line of output.split("\n")) {
    if (/warning|\bWARN\b/i.test(line)) context.diagnostic(line);
  }
}

function writeLifecycleFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    name: "install-fixture",
    version: "1.0.0",
    private: true,
    scripts: Object.fromEntries(
      ["preinstall", "install", "postinstall"].map((stage) => [
        stage,
        "node lifecycle.cjs",
      ])
    ),
  };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "yarn.lock"), "# yarn lockfile v1\n");
  fs.writeFileSync(
    path.join(dir, "package-lock.json"),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages: { "": { ...manifest, hasInstallScript: true } },
    })
  );
  // Harmless hostile-script probe: records an invocation in this disposable
  // fixture. It has no network, credentials, signing or system side effects.
  fs.writeFileSync(
    path.join(dir, "lifecycle.cjs"),
    "require('node:fs').appendFileSync('lifecycle-ran', process.env.npm_lifecycle_event + '\\n');\n"
  );
}

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
    const fixture = path.join(dir, "fixture");
    writeLifecycleFixture(fixture);
    writeLifecycleFixture(path.join(fixture, "mcp"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const writeTool = (name, body) =>
      fs.writeFileSync(
        path.join(bin, name),
        `#!${process.execPath}\n${body}\n`,
        { mode: 0o700 }
      );
    // Git supplies local fixtures. The documented shell, real Yarn install,
    // and real npm ci execute; build commands remain logged stubs.
    writeTool(
      "git",
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      if (args[0] === 'checkout') {
        fs.cpSync(${JSON.stringify(fixture)}, process.cwd(), {recursive:true});
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
      `
      const fs = require('node:fs');
      const {spawnSync} = require('node:child_process');
      const args = process.argv.slice(2);
      fs.appendFileSync('commands.log', JSON.stringify(['npm', ...args])+'\\n');
      const result = spawnSync(${JSON.stringify(
        npm
      )}, [...args, '--offline', '--no-audit', '--no-fund'], {stdio:'inherit'});
      process.exit(result.status ?? 1);
    `
    );
    const result = spawnSync("/bin/sh", ["-c", recipe(file)], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FIXTURE_CHECKOUT: checkout,
        npm_config_cache: path.join(dir, "npm-cache"),
        npm_config_ignore_scripts: "false",
        YARN_IGNORE_SCRIPTS: "false",
      },
    });
    const log = path.join(dir, "hedwig", "commands.log");
    return {
      status: result.status,
      output: `${result.stdout}\n${result.stderr}`,
      lifecycleRan: fs.existsSync(path.join(dir, "hedwig", "lifecycle-ran")),
      npmLifecycleRan: fs.existsSync(
        path.join(dir, "hedwig", "mcp", "lifecycle-ran")
      ),
      commands: fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse)
        : [],
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A missing --ignore-scripts must be observable. Check that both real package
// managers execute every probe when scripts are enabled in an empty fixture.
for (const [tool, args] of [
  [yarn, ["install", "--offline", "--non-interactive"]],
  [npm, ["ci", "--offline", "--no-audit", "--no-fund"]],
]) {
  test(`${path.basename(
    tool
  )}: lifecycle probes execute when enabled`, (context) => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "hedwig-lifecycle-control-")
    );
    try {
      writeLifecycleFixture(dir);
      const result = spawnSync(tool, args, {
        cwd: dir,
        encoding: "utf8",
        timeout: 30000,
        env: {
          ...process.env,
          npm_config_cache: path.join(dir, "npm-cache"),
          npm_config_ignore_scripts: "false",
          YARN_IGNORE_SCRIPTS: "false",
        },
      });
      reportWarnings(context, `${result.stdout}\n${result.stderr}`);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(
        fs.readFileSync(path.join(dir, "lifecycle-ran"), "utf8"),
        "preinstall\ninstall\npostinstall\n"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const file of ["docs/agents.md", "web/agents.md", "web/docs.html"]) {
  test(`${file}: Yarn and npm install lifecycle scripts cannot execute`, (context) => {
    const result = runRecipe(file, release);
    reportWarnings(context, result.output);
    assert.equal(result.status, 0, result.output);
    assert.ok(
      result.commands.some(
        ([tool, command]) => tool === "yarn" && command === "install"
      ),
      "Yarn dependency install was skipped"
    );
    assert.equal(result.lifecycleRan, false, "untrusted postinstall executed");
    assert.equal(
      result.npmLifecycleRan,
      false,
      "untrusted npm lifecycle script executed"
    );
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
    assert.equal(result.npmLifecycleRan, false);
  });
}
