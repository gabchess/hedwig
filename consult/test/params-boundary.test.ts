import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect } from "chai";
import * as ts from "typescript";

import { checkParam } from "../src/params";
import { usedByViolations } from "./params-lint";

const REPO_ROOT = join(__dirname, "..", "..");
const BUNDLE = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "params-bundle.json"), "utf8")
);

// Spelled in two parts so this file never matches its own scan.
const GENERATED_NAME = "params" + ".generated";

function filesUnder(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist") {
      return [];
    }
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? filesUnder(path, keep)
      : keep(path)
      ? [path]
      : [];
  });
}

const tsUnder = (dir: string) =>
  filesUnder(join(REPO_ROOT, dir), (path) => path.endsWith(".ts"));

// Structural numbers a Condition may spell out. None is a domain threshold:
// 0 and 1 are identities, 10000 is the basis-point scale, and 200 is the
// pre-existing length bound on a role Fact's source string.
const CATALOG_NUMBERS = new Set(["0", "1", "200", "10000", "0n", "10000n"]);
// constants.ts may spell a number only inside one of these top-level
// exported declarations. A new name fails the scan until a reviewer reads
// its number and adds the name here.
const CONSTANT_NAMES = new Set([
  "MAX_EXTRA_CONDITIONS",
  "MAX_CONDITION_ID_LENGTH",
  "MAX_INPUT_JSON_LENGTH",
  "EVIDENCE_ECHO_LIMIT",
  "MAX_ROLE_FACT_AGE_SECONDS",
  "MAX_REGISTRY_LIVE_READ_AGE_SECONDS",
  "MAX_AUTHORIZATION_WINDOW_SECONDS",
  "EVIDENCE_CLASS_WEIGHTS",
  "BAND_GREEN_MIN",
  "BAND_RED_MAX",
  "ALLOW_SUPPORT_SPAN",
  "UNKNOWN_WITH_FLOOR_FACTOR",
]);
// Outside the catalog, a literal compared against may only be 0 or 1.
const COMPARED_NUMBERS = new Set(["0", "1", "0n", "1n"]);
const COMPARISONS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

interface NumberLiteral {
  text: string;
  compared: boolean;
  // The name of the top-level declaration that holds the literal, if any.
  declaredAs: string | undefined;
  line: number;
}

// Wrappers that leave a literal's role unchanged: `(4999)`, `-5`, `+5`,
// `4999 as number`, `4999 satisfies number`, `<number>4999`, `x!`.
function unwrap(node: ts.Node): { outer: ts.Node; negative: boolean } {
  let outer = node;
  let negative = false;
  for (;;) {
    const parent = outer.parent;
    if (
      ts.isPrefixUnaryExpression(parent) &&
      (parent.operator === ts.SyntaxKind.MinusToken ||
        parent.operator === ts.SyntaxKind.PlusToken)
    ) {
      negative = negative !== (parent.operator === ts.SyntaxKind.MinusToken);
    } else if (
      !ts.isParenthesizedExpression(parent) &&
      !ts.isAsExpression(parent) &&
      !ts.isSatisfiesExpression(parent) &&
      !ts.isTypeAssertionExpression(parent) &&
      !ts.isNonNullExpression(parent)
    ) {
      return { outer, negative };
    }
    outer = parent;
  }
}

function topLevelName(node: ts.Node): string | undefined {
  for (let at: ts.Node = node; at.parent; at = at.parent) {
    if (
      ts.isVariableDeclaration(at) &&
      ts.isIdentifier(at.name) &&
      ts.isVariableStatement(at.parent.parent) &&
      ts.isSourceFile(at.parent.parent.parent)
    ) {
      return at.name.text;
    }
  }
  return undefined;
}

function numberLiterals(path: string, source: string): NumberLiteral[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const found: NumberLiteral[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) {
      const { outer, negative } = unwrap(node);
      const parent = outer.parent;
      found.push({
        text: negative ? `-${node.text}` : node.text,
        compared:
          ts.isBinaryExpression(parent) &&
          COMPARISONS.has(parent.operatorToken.kind),
        declaredAs: topLevelName(node),
        line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function thresholdLiterals(path: string, source: string): string[] {
  const where = relative(REPO_ROOT, path);
  const isCatalog = where === join("consult", "src", "catalog.ts");
  const isConstants = where === join("consult", "src", "constants.ts");
  return numberLiterals(path, source)
    .filter((lit) =>
      isCatalog
        ? !CATALOG_NUMBERS.has(lit.text)
        : isConstants
        ? lit.declaredAs === undefined || !CONSTANT_NAMES.has(lit.declaredAs)
        : lit.compared && !COMPARED_NUMBERS.has(lit.text)
    )
    .map((lit) => `${where}:${lit.line}: ${lit.text}`);
}

describe("params boundary: no value reaches the public tree", () => {
  it("no file under consult/ or mcp/ names or imports the service's generated params file", () => {
    const files = [
      ...filesUnder(join(REPO_ROOT, "consult"), () => true),
      ...filesUnder(join(REPO_ROOT, "mcp"), () => true),
    ];
    expect(files.length).to.be.greaterThan(10);
    const offenders = files.filter((path) =>
      readFileSync(path, "utf8").includes(GENERATED_NAME)
    );
    expect(offenders.map((path) => relative(REPO_ROOT, path))).to.deep.equal(
      []
    );
  });

  it("catalog.ts holds no threshold literal, and no source under consult/ or mcp/ compares against one", () => {
    const files = [...tsUnder("consult/src"), ...tsUnder("mcp/src")];
    expect(files.map((path) => relative(REPO_ROOT, path))).to.include(
      join("consult", "src", "catalog.ts")
    );
    const offenders = files.flatMap((path) =>
      thresholdLiterals(path, readFileSync(path, "utf8"))
    );
    expect(offenders).to.deep.equal([]);
  });

  it("the threshold scan fires on a literal in the catalog and on a compared literal elsewhere", () => {
    const catalog = join(REPO_ROOT, "consult", "src", "catalog.ts");
    const other = join(REPO_ROOT, "mcp", "src", "readers", "x.ts");
    expect(thresholdLiterals(catalog, "const floor = 4999;")).to.have.length(1);
    expect(thresholdLiterals(catalog, "if (holders < 0) {}")).to.deep.equal([]);
    expect(thresholdLiterals(other, "if (holders < 4999) {}")).to.have.length(
      1
    );
    expect(thresholdLiterals(other, "if (4999n >= holders) {}")).to.have.length(
      1
    );
    expect(thresholdLiterals(other, "const timeoutMs = 4999;")).to.deep.equal(
      []
    );
  });

  it("the threshold scan sees a compared literal under parentheses, a sign or a type wrapper", () => {
    const other = join(REPO_ROOT, "mcp", "src", "readers", "x.ts");
    for (const source of [
      "if (holders < (4999)) {}",
      "if (holders < -5) {}",
      "if (holders > -(4999)) {}",
      "if (holders < (4999 as number)) {}",
      "if (holders >= +4999) {}",
    ]) {
      expect(thresholdLiterals(other, source), source).to.have.length(1);
    }
    expect(thresholdLiterals(other, "if (holders < -1) {}")).to.deep.equal([
      `${join("mcp", "src", "readers", "x.ts")}:1: -1`,
    ]);
    expect(thresholdLiterals(other, "if (holders < (1)) {}")).to.deep.equal([]);
  });

  it("constants.ts holds a numeric literal only under an allowlisted exported name", () => {
    const constants = join(REPO_ROOT, "consult", "src", "constants.ts");
    expect(
      thresholdLiterals(constants, "export const HOLDERS_MIN = 4999;")
    ).to.have.length(1);
    expect(
      thresholdLiterals(constants, "export const HOLDERS_MIN = 0;")
    ).to.have.length(1);
    expect(
      thresholdLiterals(constants, "export const BAND_RED_MAX = 0.2;")
    ).to.deep.equal([]);
    expect(
      thresholdLiterals(
        constants,
        "export const BAND_RED_MAX = 0.2, HOLDERS_MIN = 4999;"
      )
    ).to.have.length(1);
    expect(
      thresholdLiterals(
        constants,
        "export function f() { const BAND_RED_MAX = 4999; return BAND_RED_MAX; }"
      )
    ).to.have.length(1);
  });

  it("every allowlisted constants.ts name is still exported there", () => {
    const source = readFileSync(
      join(REPO_ROOT, "consult", "src", "constants.ts"),
      "utf8"
    );
    const missing = [...CONSTANT_NAMES].filter(
      (name) => !new RegExp(`^export const ${name}\\b`, "m").test(source)
    );
    expect(missing).to.deep.equal([]);
  });
});

describe("params used-by lint: a v1 Check reads only check or both constants", () => {
  const consultSources = (): Record<string, string> =>
    Object.fromEntries(
      tsUnder("consult/src")
        .filter((path) => !path.endsWith(join("src", "params.ts")))
        .map((path) => [relative(REPO_ROOT, path), readFileSync(path, "utf8")])
    );

  it("passes for every consult source against the fixture bundle", () => {
    expect(usedByViolations(consultSources(), BUNDLE)).to.deep.equal([]);
  });

  const read = (key: string) =>
    `const c = checkParam(facts.params, "fixture-params-alpha", "${key}");`;

  it("allows a read of a check or both constant", () => {
    expect(
      usedByViolations({ "x.ts": read("fixture_check_a") }, BUNDLE)
    ).to.deep.equal([]);
    expect(
      usedByViolations({ "x.ts": read("fixture_both_b") }, BUNDLE)
    ).to.deep.equal([]);
  });

  for (const key of [
    "fixture_other_c",
    "fixture_unassigned_d",
    "fixture_next_e",
  ]) {
    it(`fails on a read of ${key}`, () => {
      const problems = usedByViolations({ "x.ts": read(key) }, BUNDLE);
      expect(problems).to.have.length(1);
      expect(problems[0]).to.include(key);
    });
  }

  it("fails on a read of a key the bundle does not hold", () => {
    expect(
      usedByViolations({ "x.ts": read("fixture_missing") }, BUNDLE)
    ).to.have.length(1);
  });

  it("fails on a read whose id or key is not a string literal", () => {
    const source = 'const c = checkParam(facts.params, ID, "fixture_check_a");';
    expect(usedByViolations({ "x.ts": source }, BUNDLE)).to.have.length(1);
  });

  it("fails on a read of facts.params that bypasses checkParam", () => {
    const source = 'const v = facts.params?.["fixture-params-alpha"];';
    expect(usedByViolations({ "x.ts": source }, BUNDLE)).to.have.length(1);
  });

  for (const source of [
    'const v = facts["params"]["fixture-params-alpha"]["fixture_next_e"].value;',
    "const v = facts['params'];",
    'const v = Reflect.get(facts, "params");',
    'const v = facts["par" + "ams"];',
    'const v = facts[`par${"ams"}`];',
    'const v = Reflect.get(facts, "par" + "ams");',
    'const v = Reflect.get((facts), "par" + "ams");',
    'const v = (facts)["par" + "ams"];',
    "const v = (facts as Record<string, unknown>)[k];",
    "const v = (facts satisfies object)[k];",
    "const v = (<Record<string, unknown>>facts)[k];",
    "const v = Reflect.get(facts as object, k);",
    "const v = Reflect.get(<object>facts, k);",
    'const v = facts!["par" + "ams"];',
    "const v = facts![k];",
    'const v = (facts!)?.["par" + "ams"];',
    'const v = facts["\\u0070arams"];',
    "const v = Reflect.get(facts, '\\x70arams');",
    "const v = Reflect.get?.(facts, k);",
  ]) {
    it(`fails on a direct read by string key: ${source}`, () => {
      const problems = usedByViolations({ "x.ts": source }, BUNDLE);
      expect(problems).to.have.length(1);
      expect(problems[0]).to.include("outside a checkParam call");
    });
  }

  it("allows a read of facts by a single literal key other than params", () => {
    const source =
      'const n = facts["now"]; const m = Reflect.get(facts, "now");';
    expect(usedByViolations({ "x.ts": source }, BUNDLE)).to.deep.equal([]);
    for (const wrapped of [
      'const n = (facts)["now"];',
      'const n = (facts as Record<string, unknown>)["now"];',
      'const n = facts!["now"];',
      'const n = Reflect.get((facts), "now");',
      'const n = Reflect.get(facts as object, "now");',
      "const l = facts as string[]; const q = z as T, w = facts.now;",
    ]) {
      expect(
        usedByViolations({ "x.ts": wrapped }, BUNDLE),
        wrapped
      ).to.deep.equal([]);
    }
  });

  it("ignores the import of checkParam, comments and plain strings that mention params", () => {
    const source = [
      'import { checkParam } from "./params";',
      "// reads its constants from the params input",
      "/* params note */",
      'const reason = "no constant in the params file";',
      read("fixture_check_a"),
    ].join("\n");
    expect(usedByViolations({ "x.ts": source }, BUNDLE)).to.deep.equal([]);
  });

  it("fails on params read inside a template interpolation or by destructuring", () => {
    const template = "const s = `${facts.params}`;";
    const destructure = "const { params } = facts;";
    expect(usedByViolations({ "x.ts": template }, BUNDLE)).to.have.length(1);
    expect(usedByViolations({ "x.ts": destructure }, BUNDLE)).to.have.length(1);
  });

  it("checkParam and the lint allow exactly the same used_by labels", () => {
    const id = "fixture-params-alpha";
    const key = "fixture_check_a";
    const labels = [
      "check",
      "both",
      "fixture-label-not-check",
      "fixture-label-unassigned",
      "next",
      "fixture-label-unknown",
    ];
    const verdicts = labels.map((label) => {
      const bundle = {
        [id]: { [key]: { ...BUNDLE[id][key], used_by: label } },
      };
      return {
        label,
        runtime: checkParam(bundle, id, key) !== undefined,
        lint: usedByViolations({ "x.ts": read(key) }, bundle).length === 0,
      };
    });
    for (const { label, runtime, lint } of verdicts) {
      expect(lint, label).to.equal(runtime);
    }
    expect(verdicts.filter((v) => v.runtime).map((v) => v.label)).to.deep.equal(
      ["check", "both"]
    );
  });

  it("fails against a bundle that is not a Params value", () => {
    expect(
      usedByViolations({ "x.ts": read("fixture_check_a") }, { broken: 1 })
    ).to.have.length(1);
  });
});
