#!/usr/bin/env node
"use strict";

// CI checker for augment/, the knowledge-base folder an agent reads instead
// of the source. Three jobs, none of them optional:
//
// 1. augment/data/*.json must equal what the built @hedwig/consult package
//    reports about itself right now, through @hedwig/consult/introspect.
//    Those files are generated, never hand-edited; a mismatch means someone
//    changed the catalog and forgot to regenerate them, or hand-edited the
//    data file itself.
// 2. Every reference path a condition in conditions.json names must exist
//    and be non-empty: a caller told to "read references/x.md" must find
//    real text there.
// 3. Every scenario in augment/evals/evals.json must run through consult()
//    against its own fixture and land on the expected verdict, proceed
//    flag, and set of non-PASS rows. Only the STRUCTURE is asserted, never
//    a support number: support is a display figure, not a threshold.
//
// `--self-test` proves this checker actually catches the three failure
// modes above, on a disposable temp copy, before trusting a clean run.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function loadConsult(repoRoot) {
  const indexPath = path.join(repoRoot, "consult", "dist", "index.js");
  const introspectPath = path.join(
    repoRoot,
    "consult",
    "dist",
    "introspect.js"
  );
  if (!fs.existsSync(indexPath) || !fs.existsSync(introspectPath)) {
    throw new Error(
      "consult/dist is missing; run `yarn consult:build` before augment:verify"
    );
  }
  const { consult } = require(indexPath);
  const { describeCatalog } = require(introspectPath);
  return { consult, describeCatalog };
}

function buildConditionsCatalog(describeCatalog) {
  const catalog = describeCatalog();
  return { actionTypes: catalog.actionTypes, conditions: catalog.conditions };
}

function buildKnownAddresses(describeCatalog) {
  const catalog = describeCatalog();
  const chainIds = new Set([
    ...Object.keys(catalog.canonicalAssets),
    ...Object.keys(catalog.canonicalRouters),
  ]);
  const result = {};
  for (const chainId of [...chainIds].sort()) {
    result[chainId] = {
      tokens: catalog.canonicalAssets[chainId] || {},
      routers: catalog.canonicalRouters[chainId] || {},
    };
  }
  return result;
}

function checkGeneratedFile(label, generated, committedPath, failures) {
  const expected = stableStringify(generated);
  if (!fs.existsSync(committedPath)) {
    failures.push(`${label}: ${committedPath} does not exist`);
    return;
  }
  const actual = fs.readFileSync(committedPath, "utf8");
  if (actual !== expected) {
    failures.push(
      `${label}: ${committedPath} does not match the built catalog; regenerate it`
    );
  }
}

function checkReferencePaths(conditionsCatalog, repoRoot, failures) {
  for (const condition of conditionsCatalog.conditions) {
    const referencePath = path.join(repoRoot, condition.reference);
    if (!fs.existsSync(referencePath)) {
      failures.push(
        `reference missing for ${condition.id}: ${condition.reference}`
      );
      continue;
    }
    const contents = fs.readFileSync(referencePath, "utf8");
    if (contents.trim().length === 0) {
      failures.push(
        `reference is empty for ${condition.id}: ${condition.reference}`
      );
    }
  }
}

function nonPassRows(response) {
  return response.results
    .filter((result) => result.status !== "PASS")
    .map((result) => ({
      id: result.id,
      status: result.status,
      code: result.code,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function checkEvals(augmentDir, consult, failures) {
  const evalsPath = path.join(augmentDir, "evals", "evals.json");
  const scenarios = readJson(evalsPath);
  for (const scenario of scenarios) {
    const fixturePath = path.join(
      augmentDir,
      "evals",
      "fixtures",
      scenario.fixture
    );
    const fixture = readJson(fixturePath);
    const response = consult(fixture.request, fixture.policy, fixture.facts);

    if (response.verdict !== scenario.expectedVerdict) {
      failures.push(
        `${scenario.id}: expected verdict ${scenario.expectedVerdict}, got ${response.verdict}`
      );
    }
    if (response.proceed !== scenario.expectedProceed) {
      failures.push(
        `${scenario.id}: expected proceed ${scenario.expectedProceed}, got ${response.proceed}`
      );
    }
    const actual = nonPassRows(response);
    const expected = [...scenario.expectedNonPassRows].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(
        `${scenario.id}: expected non-PASS rows ${JSON.stringify(
          expected
        )}, got ${JSON.stringify(actual)}`
      );
    }
  }
}

// Runs all three checks against one repository root and one augment/
// directory (which need not be REPO_ROOT and REPO_ROOT/augment: --self-test
// points both at a disposable copy). `consult` and `describeCatalog` always
// come from the real build: this checker verifies augment/, never consult
// itself.
function runVerification({ repoRoot, augmentDir, consult, describeCatalog }) {
  const failures = [];
  const conditionsCatalog = buildConditionsCatalog(describeCatalog);
  checkGeneratedFile(
    "conditions.json",
    conditionsCatalog,
    path.join(augmentDir, "data", "conditions.json"),
    failures
  );
  checkGeneratedFile(
    "known-addresses.json",
    buildKnownAddresses(describeCatalog),
    path.join(augmentDir, "data", "known-addresses.json"),
    failures
  );
  checkReferencePaths(conditionsCatalog, repoRoot, failures);
  checkEvals(augmentDir, consult, failures);
  return failures;
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// A disposable copy of exactly the two trees this checker reads by relative
// path: augment/ itself, and the consult/references/ tree every reference
// path in conditions.json points into. consult/dist is never copied: the
// self-test mutates augment/ data, not the catalog consult() runs against.
function makeTempCopy() {
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hedwig-augment-selftest-")
  );
  copyDirSync(path.join(REPO_ROOT, "augment"), path.join(tmpRoot, "augment"));
  copyDirSync(
    path.join(REPO_ROOT, "consult", "references"),
    path.join(tmpRoot, "consult", "references")
  );
  return tmpRoot;
}

function runSelfTest({ consult, describeCatalog }) {
  const problems = [];
  const verify = (tmpRoot) =>
    runVerification({
      repoRoot: tmpRoot,
      augmentDir: path.join(tmpRoot, "augment"),
      consult,
      describeCatalog,
    });

  // Baseline: an unmutated copy must pass cleanly, or the three mutation
  // checks below would prove nothing.
  {
    const tmpRoot = makeTempCopy();
    try {
      const failures = verify(tmpRoot);
      if (failures.length > 0) {
        problems.push(
          `baseline: expected a clean copy to pass, got: ${failures.join("; ")}`
        );
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // Mutation 1: a changed data/conditions.json must fail the generated-file
  // check.
  {
    const tmpRoot = makeTempCopy();
    try {
      const conditionsPath = path.join(
        tmpRoot,
        "augment",
        "data",
        "conditions.json"
      );
      const conditions = readJson(conditionsPath);
      conditions.conditions[0].id = `${conditions.conditions[0].id}-mutated`;
      fs.writeFileSync(conditionsPath, stableStringify(conditions));
      const failures = verify(tmpRoot);
      if (failures.length === 0) {
        problems.push(
          "a mutated data/conditions.json did not fail verification"
        );
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // Mutation 2: a dropped reference file must fail the reference-path
  // check.
  {
    const tmpRoot = makeTempCopy();
    try {
      const conditionsPath = path.join(
        tmpRoot,
        "augment",
        "data",
        "conditions.json"
      );
      const conditions = readJson(conditionsPath);
      const referencePath = path.join(
        tmpRoot,
        conditions.conditions[0].reference
      );
      fs.rmSync(referencePath, { force: true });
      const failures = verify(tmpRoot);
      if (failures.length === 0) {
        problems.push("a dropped reference file did not fail verification");
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // Mutation 3: a flipped expected verdict must fail the evals check.
  {
    const tmpRoot = makeTempCopy();
    try {
      const evalsPath = path.join(tmpRoot, "augment", "evals", "evals.json");
      const scenarios = readJson(evalsPath);
      scenarios[0].expectedVerdict =
        scenarios[0].expectedVerdict === "DENY" ? "ALLOW_UNDER_POLICY" : "DENY";
      fs.writeFileSync(evalsPath, stableStringify(scenarios));
      const failures = verify(tmpRoot);
      if (failures.length === 0) {
        problems.push("a flipped eval verdict did not fail verification");
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // Mutation 4: a changed code on an expected non-PASS row must fail, so a
  // Condition that starts failing for a different reason cannot pass silently.
  {
    const tmpRoot = makeTempCopy();
    try {
      const evalsPath = path.join(tmpRoot, "augment", "evals", "evals.json");
      const scenarios = readJson(evalsPath);
      const withRow = scenarios.find((s) => s.expectedNonPassRows.length > 0);
      withRow.expectedNonPassRows[0].code = "SOME_OTHER_CODE";
      fs.writeFileSync(evalsPath, stableStringify(scenarios));
      const failures = verify(tmpRoot);
      if (failures.length === 0) {
        problems.push("a changed expected code did not fail verification");
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  return problems;
}

// `--write` regenerates the two data files from the built catalog, so the
// only path to a changed data file is through the code that describes it.
function writeGeneratedFiles(augmentDir, describeCatalog) {
  const dataDir = path.join(augmentDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "conditions.json"),
    stableStringify(buildConditionsCatalog(describeCatalog))
  );
  fs.writeFileSync(
    path.join(dataDir, "known-addresses.json"),
    stableStringify(buildKnownAddresses(describeCatalog))
  );
}

function main() {
  const args = process.argv.slice(2);
  const selfTest = args.includes("--self-test");
  const write = args.includes("--write");
  const { consult, describeCatalog } = loadConsult(REPO_ROOT);

  if (write) {
    writeGeneratedFiles(path.join(REPO_ROOT, "augment"), describeCatalog);
    process.stdout.write("augment-verify: data files written\n");
  }

  if (selfTest) {
    const problems = runSelfTest({ consult, describeCatalog });
    if (problems.length > 0) {
      for (const problem of problems) {
        process.stderr.write(`augment-verify --self-test: ${problem}\n`);
      }
      process.exitCode = 1;
      return;
    }
    process.stdout.write("augment-verify --self-test: passed\n");
    return;
  }

  const failures = runVerification({
    repoRoot: REPO_ROOT,
    augmentDir: path.join(REPO_ROOT, "augment"),
    consult,
    describeCatalog,
  });
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`augment-verify: ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write("augment-verify: passed\n");
}

main();
