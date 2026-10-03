import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect } from "chai";
import * as ts from "typescript";

import { checkParam } from "../src/params";
import {
  OPAQUE_CALLEES,
  OPAQUE_FUNCTIONS,
  usedByViolations,
} from "./params-lint";

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

describe("params boundary: no value reaches the public tree", function () {
  this.timeout(60000);

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

// Mutation check for the AST lint (T28, redesign after three rounds of text
// scan bypasses). Each rule in params-lint.ts was removed or inverted alone in
// a scratch copy, and the "used-by lint" tests were run against it. A mutant
// that no test failed meant a rule with no test. The first pass left nine
// survivors: eight got a test, and the ninth (an explicit destructuring
// assignment rule) was redundant with the store rule and was removed. A second
// pass left two more (`with`, a spread argument), which got tests. The final
// pass of 52 mutants was caught by at least one test each. The mutants, by rule:
//   transparent wrappers   paren, `as`, `satisfies`, `<T>`, `!`, `await` each
//                          not unwrapped
//   key reads              `params` key dropped, any-receiver `.facts` dropped,
//                          a computed element key allowed, a Reflect.get key
//                          allowed, a helper call-site key allowed, a
//                          parametric read always allowed, a reassigned key
//                          parameter ignored
//   flow                   no flow through a call, an assignment, a return or a
//                          declaration; `context`, `ConditionContext` and
//                          `{ facts }` no longer containers
//   uses of a tracked      spread, `for...in`, copy into an object, store into
//   value                  another place, unknown callee, spread argument,
//                          rest parameter, template tag, checkParam argument,
//                          every fall-through all allowed
//   destructuring          rest, array, computed key and `params` key allowed
//   the gate               any callee taken as checkParam, an own checkParam
//                          function or variable, an import from another
//                          module, a P read allowed everywhere, a P in a
//                          conditional test or a `??` operand mis-climbed
//   fail closed            parse errors ignored, banned names, `with`, Reflect
//                          outside a direct call, `Object.hasOwn(facts,
//                          "params")` and `"params" in facts` allowed
//   trusted names          matched in any file, not only the declaring one
//   scope                  types and imports scanned as code
// To redo one: apply a single change above to a copy of params-lint.ts and run
// `yarn consult:test --grep "used-by lint"`. A change no test notices is a gap.
describe("params used-by lint: a v1 Check reads only check or both constants", function () {
  this.timeout(60000);

  const consultSources = (): Record<string, string> =>
    Object.fromEntries(
      tsUnder("consult/src")
        .filter((path) => !path.endsWith(join("src", "params.ts")))
        .map((path) => [relative(REPO_ROOT, path), readFileSync(path, "utf8")])
    );

  it("passes for every consult source against the fixture bundle", function () {
    this.timeout(60000);
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
    "const ok = facts.slot < facts.params.p.end.value && facts.slot > facts.start;",
    'if (amount < facts.params["p"]["max"].value && fee > facts.fee) {}',
    "const ok = a < facts[key] && b > facts.now;",
    "const ok = a < context.facts.params && b > facts.now;",
    "return lo < facts.params.cap && hi > facts.now.at;",
    'const ok = "a" < facts.params.cap && b > facts.now;',
    "const ok = x! < facts.params.cap && b > facts.now;",
    "const v = Reflect.get?.(facts, k);",
  ]) {
    it(`fails on a direct read by string key: ${source}`, () => {
      const problems = usedByViolations({ "x.ts": source }, BUNDLE);
      expect(problems).to.have.length(1);
      expect(problems[0]).to.include("outside a checkParam call");
    });
  }

  // Every way the three review rounds got a read of facts.params past the
  // old text scan, plus the forms a parser makes easy to miss. Each must fail
  // with at least one problem. A source is one file; `many` lists files that
  // are linted together.
  const OWN_LOOKUP =
    "function ownLookup<T>(source: unknown, key: unknown): T | undefined { if (typeof key !== 'string' || source === null || typeof source !== 'object' || !Object.hasOwn(source, key)) { return undefined; } return (source as Record<string, T>)[key]; }\n";
  const BYPASSES: Record<string, string[]> = {
    "an escaped identifier": [
      "const v = facts.\\u0070arams.a;",
      "const v = facts.\\u0070arams;",
      "const { \\u0070arams: p } = facts;",
      "const v = fa\\u0063ts.params;",
      'const v = fa\\u0063ts["params"];',
      "const v = R\\u0065flect.get(facts, k);",
    ],
    "an escape inside a string key": [
      'const v = facts["\\x70arams"];',
      "const v = Reflect.get(facts, '\\u{70}arams');",
      '// prettier-ignore\nconst v = facts["\\u0070arams"];',
    ],
    "a quote or comment opener inside a template or regex": [
      'const v = `the cap is "${facts.params.cap}"`;',
      'const re = /"/; const v = facts.params.cap; const w = /"/;',
      "const s = `/*${facts.params.cap}`; const t = `*/`;",
      "const s = '\"'; const v = facts.params.cap; const t = '\"';",
      'const v = facts.params; /* "params */',
    ],
    "a receiver the text scan did not see": [
      'const v = Reflect.get(( facts ), "par" + "ams");',
      "const v = Reflect.get(( facts ), k);",
      "const v = (facts as any)!['params'];",
      "const v = (facts ?? {})[k];",
      "const v = (facts ?? {}).params;",
      "const v = (facts || {}).params;",
      "const v = (true ? facts : {}).params;",
      "const v = (0, facts).params;",
      "const v = (await facts).params;",
    ],
    "a cast type the text scan could not parse": [
      "const v = (facts as { [k: string]: unknown })[k];",
      "const v = (facts as {})[k];",
      "const v = (facts as Record<string, Record<string, Record<string, unknown>>>)[k];",
      "const v = (facts as typeof x)[k];",
      "const v = (facts as keyof T)[k];",
      "const v = (facts as (A | B))[k];",
      "const v = (facts as [string])[k];",
      "const v = (facts as unknown as Record<string, unknown>)[k];",
      "const v = Reflect.get(facts as [string], k);",
      "const v = Reflect.get(context?.facts as object, k);",
    ],
    "another way to call Reflect.get": [
      "const v = Reflect.get(context?.facts, k);",
      'const v = Reflect["get"](facts, k);',
      "const v = Reflect.get.call(null, facts, k);",
      "const v = Reflect?.get(facts, k);",
      "const v = globalThis.Reflect.get(facts, k);",
      "const v = (0, Reflect.get)(facts, k);",
      "const g = Reflect.get; g(facts, k);",
      "const { get } = Reflect;",
      "const v = Reflect.ownKeys(facts);",
      'const v = Reflect.get(facts, "now", facts);',
    ],
    "the container of facts, by a string key or a dynamic one": [
      'const v = context["facts"][k];',
      'const v = (context["facts"] as Record<string, unknown>)[k];',
      'const v = (context[\'facts\'] as Record<string, unknown>)["par" + "ams"];',
      "const v = context[k];",
      'const v = context["fa" + "cts"].params;',
      "const c = context; const v = c[k];",
      "const v = (x as any).facts.params;",
      "const v = this.facts[k];",
      "const { facts: { params } } = context;",
      "const t = { ...context };",
    ],
    destructuring: [
      "const { params: p } = facts;",
      'const { ["par" + "ams"]: p } = facts;',
      "const { ...rest } = facts;",
      "const [a] = facts;",
      "const { facts: z } = something; const v = z.params;",
      "function f(this: any, { facts: z }: any) { return z.params; }",
      "const o = { policy, facts }; const { facts: z } = o; const v = z.params;",
      "const { x } = { ...facts };",
    ],
    "a helper or built-in that reads facts for the caller": [
      OWN_LOOKUP + 'const v = ownLookup(facts as object, "par" + "ams");',
      OWN_LOOKUP + "const v = ownLookup(facts as object, k);",
      OWN_LOOKUP + 'const v = ownLookup(facts as object, "params");',
      OWN_LOOKUP +
        "const v = ownLookup<unknown>(context.facts as object, 'params');",
      "function get(o: any, k: string) { return o[k]; } get(facts, k);",
      "function get(o: any, k: string) { const kk = k; return o[kk]; } get(facts, 'now');",
      "function get(o: any, k: string) { k = 'params'; return o[k]; } get(facts, 'now');",
      "function get(o: any, k: string) { return o[k]; } function outer(o: any, k: string) { return get(o, k); } outer(facts, 'params');",
      "const v = Object.getOwnPropertyDescriptor(facts, k);",
      "const v = Object.keys(facts);",
      "const v = Object.entries(facts);",
      "const v = Object.values(facts);",
      "const v = Object.assign({}, facts);",
      "const v = JSON.stringify(facts);",
      "const v = { ...facts };",
      "const v = [facts];",
      "const v = { x: facts };",
      "const v = new Foo(facts);",
      "const v = helper(facts);",
      "const v = tag`${facts}`;",
      "for (const k in facts) {}",
      "for (const x of facts as any) {}",
      'const v = Object.hasOwn(facts, "params");',
      'const v = "params" in facts;',
    ],
    "an alias, a parameter or a return that carries facts": [
      "const f = facts; const v = f.params;",
      "const f = facts; const v = f[k];",
      "const { facts: g } = context; const v = g.params;",
      "let f: any; f = facts; const v = f.params;",
      "function h(x: any) { return x.params; } h(facts);",
      "function h(x: any) { return x[k]; } h(facts);",
      "function h({ params }: any) { return params; } h(facts);",
      "const h = (x: any) => x.params; h(facts);",
      "function f(a = facts) { return a.params; }",
      "function id(x: any) { return x; } const v = id(facts).params;",
      "const v = ((x) => x)(facts).params;",
      "const v = structuredClone(facts).params;",
      "const v = Object.freeze(facts).params;",
      "let saved: any; function s() { saved = facts; } function t() { return saved.params; }",
      "class A { f = facts; read() { return this.f; } }",
      "this.facts = facts; const v = this.facts.params;",
      "const c = { policy, facts }; const v = c.facts.params;",
      "const c = { policy, facts }; const v = c[k];",
      "function check(r: R, c: ConditionContext) { return c[k]; }",
      'const check = (r: R, c: ConditionContext) => c["fa" + "cts"];',
      "function check(r: R, c: ConditionContext) { return c.facts.params; }",
      "const f = async () => { const x = await facts; return x.params; };",
      "function* g() { yield facts; }",
      "const o: any = {}; o.x = facts;",
      "this.x = facts;",
      "let a: any; ({ params: a } = facts);",
      "function h(a: any, b: any) { return a.params; } const xs: any[] = []; h(...xs, facts);",
      "export default facts;",
    ],
    "a word that hides a read": [
      "const v = arguments[0];",
      'const v = eval("facts.params");',
      'const v = globalThis["facts"];',
      "with (facts) { params; }",
      "declare const o: any; with (o) { }",
      "function h(...args: any[]) { return args[0].params; } h(facts);",
      "const v = Promise.resolve(facts).then((f: any) => f.params);",
      "const v = [facts].map((f: any) => f.params);",
    ],
    "a gate other than the real checkParam": [
      'const v = checkParam(facts, "fixture-params-alpha", "fixture_check_a");',
      'const v = facts.params; const w = checkParam(v, "fixture-params-alpha", "fixture_check_a");',
      'const cp = checkParam; cp(facts.params, "fixture-params-alpha", "fixture_check_a");',
      'checkParam.call(null, facts.params, "fixture-params-alpha", "fixture_check_a");',
      'function checkParam(p: any, a: string, b: string) { return p.anything; } const v = checkParam(facts.params, "fixture-params-alpha", "fixture_check_a");',
      'const checkParam = (p: any, a: string, b: string) => p.x; const v = checkParam(facts.params, "fixture-params-alpha", "fixture_check_a");',
      'const p = checkParam(facts.params ? x : y, "fixture-params-alpha", "fixture_check_a");',
      'import { checkParam } from "./evil"; const v = 1;',
      "const v = facts.params +",
    ],
  };
  for (const [name, sources] of Object.entries(BYPASSES)) {
    it(`fails on ${name}`, () => {
      for (const source of sources) {
        const problems = usedByViolations({ "x.ts": source }, BUNDLE);
        expect(problems.length, source).to.be.greaterThan(0);
      }
    });
  }

  // A read inside a comparison, on either side of the `<`. An earlier version lost it to
  // the `<T>` cast strip.
  const READS = [
    "facts.params.cap",
    'facts["par" + "ams"]',
    "facts[k]",
    "(facts as Record<string, unknown>)[k]",
    "Reflect.get(facts, k)",
    "context.facts.params",
  ];
  const LEFTS = [
    "lo",
    "x!",
    '"a"',
    "a++",
    "`t`",
    "f()",
    "a[0]",
    "1",
    "-a",
    "a.b",
    "(a)",
    "/r/",
  ];
  const RIGHTS = ["hi > facts.now", "hi > r", "b > c.d", "hi > (facts as T).x"];
  for (const read of READS) {
    it(`fails on ${read} inside a comparison`, () => {
      for (const left of LEFTS) {
        for (const right of RIGHTS) {
          for (const source of [
            `const ok = ${left} < ${read} && ${right};`,
            `const ok = ${right.replace("hi >", "hi <")} || ${read} > ${left};`,
          ]) {
            const problems = usedByViolations({ "x.ts": source }, BUNDLE);
            expect(problems.length, source).to.be.greaterThan(0);
          }
        }
      }
    });
  }

  it("follows facts from one file into a function declared in another", () => {
    const callee = "export function g(x: any) { return x.params; }";
    const reject = (many: Record<string, string>) =>
      expect(usedByViolations(many, BUNDLE).length).to.be.greaterThan(0);
    reject({
      "a.ts": callee,
      "b.ts": 'import { g } from "./a"; const v = g(facts);',
    });
    reject({
      "a.ts": callee,
      "b.ts": 'import { g } from "./a"; const v = g(context.facts);',
    });
    // An import under another name cannot be resolved, so the call fails closed.
    reject({
      "a.ts": "export function g(x: any) { return x.now; }",
      "b.ts": 'import { g as h } from "./a"; const v = h(facts);',
    });
    expect(
      usedByViolations(
        {
          "a.ts": "export function g(x: any) { return x.now; }",
          "b.ts": 'import { g } from "./a"; const v = g(facts);',
        },
        BUNDLE
      )
    ).to.deep.equal([]);
  });

  it("trusts an engine function by name only in the file that declares it", () => {
    const body =
      "export function deepFreeze<T>(value: T): T { Object.values(value as any); return value; }\nconst v = deepFreeze(facts);";
    expect(
      usedByViolations({ "consult/src/catalog.ts": body }, BUNDLE)
    ).to.deep.equal([]);
    expect(
      usedByViolations({ "consult/src/other.ts": body }, BUNDLE).length
    ).to.be.greaterThan(0);
    expect(
      usedByViolations(
        { "consult/src/other.ts": "const v = deepFreeze(facts).params;" },
        BUNDLE
      ).length
    ).to.be.greaterThan(0);
  });

  it("every trusted engine name is still declared where the lint trusts it", () => {
    for (const { file, name } of OPAQUE_FUNCTIONS) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      expect(
        new RegExp(`^(export )?function ${name}\\b`, "m").test(source),
        `${file} ${name}`
      ).to.equal(true);
    }
    for (const { file, name } of OPAQUE_CALLEES) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      expect(source.includes(`${name}(`), `${file} ${name}`).to.equal(true);
    }
  });

  it("does not parse a file with a syntax error", () => {
    const problems = usedByViolations({ "x.ts": "const = ;" }, BUNDLE);
    expect(problems).to.have.length(1);
    expect(problems[0]).to.include("does not parse");
  });

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
      "const ok = a < facts.now && b > facts.start;",
      'const n = Reflect.get(<object>facts, "now");',
      'const name = "params"; throw new Error("params"); const o = { kind: "params" };',
      "const { params } = request; const x = params.a;",
      "function f(params: unknown) { return (params as any).x; }",
      "const o = { params: 1 }; const v = o.params;",
      "const v = request.params.id;",
      'const ok = facts !== null && typeof facts === "object" && !Array.isArray(facts);',
      "const v = Object.hasOwn(facts, k); const w = k in facts;",
      "const { now, solanaRole: role } = context.facts as any;",
      "const n = (facts satisfies Record<string, unknown>).now;",
      "const c = structuredClone(facts); const n = (c as any).now; const d = Object.freeze(facts);",
      'const p = checkParam(c ? facts.params : undefined, "fixture-params-alpha", "fixture_check_a");',
      "async function f() { return ((await facts) as any).now; }",
      "function check(r: R, c: ConditionContext) { return (c.facts as any).now; }",
      "const v = facts === undefined ? 0 : (facts as any).now;",
      "type T = typeof facts.params; interface I { facts: unknown } const z: I['facts'] = 1;",
      "type T = typeof facts; const t = x as typeof facts;",
      OWN_LOOKUP +
        'const v = ownLookup<unknown>(facts as object, "registryAsset");',
      OWN_LOOKUP + "const v = ownLookup<string>(table, chainId);",
      OWN_LOOKUP +
        'const f = (k: string) => ownLookup<unknown>(fact, k); const x = f("a");',
      "function readNow(facts: unknown) { return (facts as Record<string, unknown>).now; } const n = readNow(context.facts);",
      'function a(facts: unknown) { return checkParam((facts as any).params ?? undefined, "fixture-params-alpha", "fixture_both_b"); }',
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
