import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect } from "chai";
import * as ts from "typescript";

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
  line: number;
}

function numberLiterals(path: string, source: string): NumberLiteral[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const found: NumberLiteral[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) {
      const parent = node.parent;
      found.push({
        text: node.text,
        compared:
          ts.isBinaryExpression(parent) &&
          COMPARISONS.has(parent.operatorToken.kind),
        line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function thresholdLiterals(path: string, source: string): string[] {
  const isCatalog =
    relative(REPO_ROOT, path) === join("consult", "src", "catalog.ts");
  return numberLiterals(path, source)
    .filter((lit) =>
      isCatalog
        ? !CATALOG_NUMBERS.has(lit.text)
        : lit.compared && !COMPARED_NUMBERS.has(lit.text)
    )
    .map((lit) => `${relative(REPO_ROOT, path)}:${lit.line}: ${lit.text}`);
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

  it("fails against a bundle that is not a Params value", () => {
    expect(
      usedByViolations({ "x.ts": read("fixture_check_a") }, { broken: 1 })
    ).to.have.length(1);
  });
});
