import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect } from "chai";
import * as ts from "typescript";

import { PARAM_READS, paramReadViolations } from "../src/params";

const REPO_ROOT = join(__dirname, "..", "..");
const BUNDLE_PATH = join(__dirname, "fixtures", "params-bundle.json");
const BUNDLE = JSON.parse(readFileSync(BUNDLE_PATH, "utf8"));

// Built at run time so neither the raw-text scan nor the folded-string scan
// below matches this file.
const GENERATED_NAME = ["params", "generated"].join(".");

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

const CODE_FILE = /\.[cm]?[jt]sx?$/;
const where = (path: string) => relative(REPO_ROOT, path);
const posix = (path: string) => where(path).split(sep).join("/");
const lineOf = (file: ts.SourceFile, node: ts.Node) =>
  file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
const parse = (path: string, source: string) =>
  ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);

// Structural numbers any source under consult/src but constants.ts may spell
// out. None is a domain threshold: 0 and 1 are identities, 10000 is the
// basis-point scale, and 200 is the pre-existing length bound on a role
// Fact's source string.
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
  "MAX_MARKET_READING_AGE_SECONDS",
  "SECONDS_PER_HOUR",
  "MAX_AUTHORIZATION_WINDOW_SECONDS",
  "EVIDENCE_CLASS_WEIGHTS",
  "BAND_GREEN_MIN",
  "BAND_RED_MAX",
  "ALLOW_SUPPORT_SPAN",
  "UNKNOWN_WITH_FLOOR_FACTOR",
]);
// Any other source under consult/src may spell a number outside
// CATALOG_NUMBERS only inside one of these reviewed top-level declarations
// of that file. A new file has none, so a number in it fails the scan.
const SOURCE_NAMES: Readonly<Record<string, readonly string[]>> = {
  // Public Router02 ABI layout and uint widths. No policy values live here.
  "consult/src/monad-calldata.ts": ["ROUTER02_LAYOUT"],
  "consult/src/core.ts": ["STATUS_RANK"],
  "consult/src/support.ts": ["round2"],
  "consult/src/guard-internal.ts": [
    "DEFAULT_GATHER_DEADLINE_MS",
    "DEFAULT_SIGNER_DEADLINE_MS",
    "MAX_TIMEOUT_MS",
  ],
};
// Outside the catalog, a literal compared against may only be 0 or 1.
const COMPARED_NUMBERS = new Set(["0", "1", "0n", "1n"]);
// Comparisons in mcp/src against another number, each read by a reviewer:
// wire-format sizes, an HTTP status, a parity test, the JSON-RPC version
// and Monad's public mainnet chain ID. Domain thresholds stay private.
// A new one fails the scan until its number is read and its text is added
// here.
const REVIEWED_COMPARISONS = new Set([
  "mcp/src/readers/pda.ts: bytes.length !== 32",
  'mcp/src/readers/registry-asset.ts: entry.jsonrpc !== "2.0"',
  "mcp/src/readers/registry-asset.ts: signatures.length !== 2",
  "mcp/src/readers/registry-asset.ts: response.status !== 200",
  "mcp/src/readers/registry-asset.ts: base.chainNumber === 143",
  'mcp/src/readers/solana-role.ts: body.jsonrpc !== "2.0"',
  "mcp/src/readers/solana-role.ts: pair.length !== 2",
  "mcp/src/readers/solana-role.ts: response.status !== 200",
  "mcp/src/readers/wire.ts: hex.length % 2 === 1",
]);
const COMPARISONS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
const ARITHMETIC = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
]);
const BITWISE = new Set([
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);
// Operators a compared operand is searched through for a constant: `h - 4999`
// and `h ^ 4999` both give 4999. A mask, `bytes[31] & 0x80`, is left alone.
const SEARCHED = new Set<ts.SyntaxKind>(
  [...ARITHMETIC, ...BITWISE].filter(
    (kind) => kind !== ts.SyntaxKind.AmpersandToken
  )
);
// A string that reads as a decimal number: "4999", " 49.99 ", "-5e3".
const DECIMAL = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;
const NUMBER_PARSERS = new Set(["Number", "BigInt", "parseInt", "parseFloat"]);

// Wrappers that leave a value's role unchanged: `(4999)`, `4999 as number`,
// `4999 satisfies number`, `<number>4999`, `x!`.
type Wrapper =
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.SatisfiesExpression
  | ts.TypeAssertion
  | ts.NonNullExpression;
const isWrapper = (node: ts.Node): node is Wrapper =>
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isTypeAssertionExpression(node) ||
  ts.isNonNullExpression(node);

const isSign = (node: ts.Node): node is ts.PrefixUnaryExpression =>
  ts.isPrefixUnaryExpression(node) &&
  (node.operator === ts.SyntaxKind.MinusToken ||
    node.operator === ts.SyntaxKind.PlusToken);

const isBitwiseNot = (node: ts.Node): node is ts.PrefixUnaryExpression =>
  ts.isPrefixUnaryExpression(node) &&
  node.operator === ts.SyntaxKind.TildeToken;

// A wrapper or a sign around a literal: `-5`, `+(4999)`.
function unwrap(node: ts.Node): { outer: ts.Node; negative: boolean } {
  let outer = node;
  let negative = false;
  for (;;) {
    const parent = outer.parent;
    if (isSign(parent)) {
      negative = negative !== (parent.operator === ts.SyntaxKind.MinusToken);
    } else if (!isWrapper(parent)) {
      return { outer, negative };
    }
    outer = parent;
  }
}

type Constant = number | bigint | string;

// JavaScript's own rules, so the folded value is the one the code computes.
// A mix it would throw on (a bigint and a number) folds to nothing.
function arithmetic(
  kind: ts.SyntaxKind,
  left: Constant,
  right: Constant
): Constant | undefined {
  const l: any = left;
  const r: any = right;
  try {
    switch (kind) {
      case ts.SyntaxKind.PlusToken:
        return l + r;
      case ts.SyntaxKind.MinusToken:
        return l - r;
      case ts.SyntaxKind.AsteriskToken:
        return l * r;
      case ts.SyntaxKind.SlashToken:
        return l / r;
      case ts.SyntaxKind.PercentToken:
        return l % r;
      case ts.SyntaxKind.AsteriskAsteriskToken:
        return l ** r;
      case ts.SyntaxKind.AmpersandToken:
        return l & r;
      case ts.SyntaxKind.BarToken:
        return l | r;
      case ts.SyntaxKind.CaretToken:
        return l ^ r;
      case ts.SyntaxKind.LessThanLessThanToken:
        return l << r;
      case ts.SyntaxKind.GreaterThanGreaterThanToken:
        return l >> r;
      default:
        return l >>> r;
    }
  } catch {
    return undefined;
  }
}

// The value of an expression built only from literals, or undefined.
function fold(node: ts.Node | undefined): Constant | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }
  if (ts.isBigIntLiteral(node)) {
    try {
      return BigInt(node.text.slice(0, -1));
    } catch {
      return undefined;
    }
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const part = fold(span.expression);
      if (part === undefined) {
        return undefined;
      }
      text += String(part) + span.literal.text;
    }
    return text;
  }
  if (isWrapper(node)) {
    return fold(node.expression);
  }
  if (isSign(node)) {
    const value = fold(node.operand);
    if (value === undefined) {
      return undefined;
    }
    const minus = node.operator === ts.SyntaxKind.MinusToken;
    if (typeof value === "bigint") {
      return minus ? -value : undefined;
    }
    return minus ? -Number(value) : Number(value);
  }
  if (isBitwiseNot(node)) {
    const value: any = fold(node.operand);
    return value === undefined ? undefined : ~value;
  }
  if (
    ts.isBinaryExpression(node) &&
    (ARITHMETIC.has(node.operatorToken.kind) ||
      BITWISE.has(node.operatorToken.kind))
  ) {
    const left = fold(node.left);
    const right = fold(node.right);
    return left === undefined || right === undefined
      ? undefined
      : arithmetic(node.operatorToken.kind, left, right);
  }
  return undefined;
}

const render = (value: number | bigint) =>
  typeof value === "bigint" ? `${value}n` : String(value);

function calleeName(call: ts.CallExpression): string | undefined {
  let callee: ts.Node = call.expression;
  while (isWrapper(callee)) {
    callee = callee.expression;
  }
  return ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : undefined;
}

function isMathBound(call: ts.CallExpression): boolean {
  let callee: ts.Node = call.expression;
  while (isWrapper(callee)) {
    callee = callee.expression;
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Math" &&
    (callee.name.text === "min" || callee.name.text === "max")
  );
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
    if (
      ts.isFunctionDeclaration(at) &&
      at.name !== undefined &&
      ts.isSourceFile(at.parent)
    ) {
      return at.name.text;
    }
  }
  return undefined;
}

interface Site {
  text: string;
  // The name of the top-level declaration that holds the value, if any.
  declaredAs: string | undefined;
  line: number;
}

// Every number a source spells: each numeric literal, each expression of
// literals that folds to a number (`10000 - 200 - 200`), each constant
// string that reads as a number, and each constant string handed to
// Number, BigInt, parseInt or parseFloat (`BigInt("0x1387")`).
function valueSites(path: string, source: string): Site[] {
  const file = parse(path, source);
  const sites = new Map<ts.Node, string>();
  const visit = (node: ts.Node): void => {
    const value = fold(node);
    if (
      value !== undefined &&
      fold(node.parent) === undefined &&
      (typeof value !== "string" || DECIMAL.test(value))
    ) {
      sites.set(
        node,
        render(typeof value === "string" ? Number(value) : value)
      );
    }
    if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) {
      const { outer, negative } = unwrap(node);
      sites.set(outer, negative ? `-${node.text}` : node.text);
    }
    if (
      ts.isCallExpression(node) &&
      NUMBER_PARSERS.has(calleeName(node) ?? "")
    ) {
      for (const arg of node.arguments) {
        const text = fold(arg);
        if (typeof text === "string" && !sites.has(arg)) {
          const number = Number(text.trim());
          sites.set(
            arg,
            Number.isFinite(number) ? render(number) : JSON.stringify(text)
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...sites].map(([node, text]) => ({
    text,
    declaredAs: topLevelName(node),
    line: lineOf(file, node),
  }));
}

// The constant parts of a compared operand, through wrappers, signs, `~`,
// arithmetic and SEARCHED bitwise operators: `h - 4999` gives 4999, and
// `4999 + 1` gives 5000.
function constantParts(node: ts.Node, out: ts.Node[]): void {
  if (fold(node) !== undefined) {
    out.push(node);
  } else if (isWrapper(node)) {
    constantParts(node.expression, out);
  } else if (isSign(node) || isBitwiseNot(node)) {
    constantParts(node.operand, out);
  } else if (
    ts.isBinaryExpression(node) &&
    SEARCHED.has(node.operatorToken.kind)
  ) {
    constantParts(node.left, out);
    constantParts(node.right, out);
  }
}

// Every number compared against: an operand of <, <=, >, >=, ==, ===, !=
// or !==, or an argument of Math.min or Math.max. A constant string counts
// when JavaScript reads it as a finite number ("4999", "0x1387", "2.0"); ""
// reads as 0.
function comparedSites(
  path: string,
  source: string
): (Site & { comparison: string })[] {
  const file = parse(path, source);
  const found: (Site & { comparison: string })[] = [];
  const visit = (node: ts.Node): void => {
    const operands =
      ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)
        ? [node.left, node.right]
        : ts.isCallExpression(node) && isMathBound(node)
        ? [...node.arguments]
        : [];
    for (const operand of operands) {
      const parts: ts.Node[] = [];
      constantParts(operand, parts);
      for (const part of parts) {
        const folded = fold(part);
        const value = typeof folded === "string" ? Number(folded) : folded;
        if (
          typeof value === "bigint" ||
          (typeof value === "number" && Number.isFinite(value))
        ) {
          found.push({
            text: render(value),
            declaredAs: undefined,
            line: lineOf(file, part),
            comparison: node.getText(file),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function thresholdLiterals(path: string, source: string): string[] {
  const at = where(path);
  const isCatalog = at === join("consult", "src", "catalog.ts");
  const isConstants = at === join("consult", "src", "constants.ts");
  const inConsultSrc = at.startsWith(join("consult", "src") + sep);
  const names = new Set(SOURCE_NAMES[posix(path)] ?? []);
  const spelled = inConsultSrc
    ? valueSites(path, source).filter((site) =>
        isConstants
          ? site.declaredAs === undefined ||
            !CONSTANT_NAMES.has(site.declaredAs)
          : !CATALOG_NUMBERS.has(site.text) &&
            (site.declaredAs === undefined || !names.has(site.declaredAs))
      )
    : [];
  const compared =
    isCatalog || isConstants
      ? []
      : comparedSites(path, source).filter(
          (site) =>
            !COMPARED_NUMBERS.has(site.text) &&
            !REVIEWED_COMPARISONS.has(`${posix(path)}: ${site.comparison}`)
        );
  return [...spelled, ...compared].map(
    (site) => `${at}:${site.line}: ${site.text}`
  );
}

// The text a string literal, a template or a `+` chain spells, as runs of
// constant text: `dir + "/a" + ".b"` gives "/a.b".
function pieces(node: ts.Node): (string | undefined)[] {
  const value = fold(node);
  if (value !== undefined) {
    return [String(value)];
  }
  if (isWrapper(node)) {
    return pieces(node.expression);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return [...pieces(node.left), ...pieces(node.right)];
  }
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.flatMap((span) => [
        ...pieces(span.expression),
        span.literal.text,
      ]),
    ];
  }
  return [undefined];
}

function constantRuns(node: ts.Node): string[] {
  const runs = [""];
  for (const piece of pieces(node)) {
    if (piece === undefined) {
      runs.push("");
    } else {
      runs[runs.length - 1] += piece;
    }
  }
  return runs;
}

// The generated file's name in the raw text, or in a code file spelled by a
// string, a template or a concatenation, however it is split or escaped.
function generatedNameHits(path: string, source: string): string[] {
  const hits = source.includes(GENERATED_NAME)
    ? [`${where(path)}: names the generated params file`]
    : [];
  if (!CODE_FILE.test(path)) {
    return hits;
  }
  const file = parse(path, source);
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node) ||
        (ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.PlusToken)) &&
      constantRuns(node).some((run) => run.includes(GENERATED_NAME))
    ) {
      hits.push(
        `${where(path)}:${lineOf(
          file,
          node
        )}: spells the generated params file name`
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

function propertyKey(name: ts.PropertyName): Constant | undefined {
  return ts.isComputedPropertyName(name)
    ? fold(name.expression)
    : ts.isIdentifier(name) || ts.isStringLiteral(name)
    ? name.text
    : undefined;
}

// A read of a member named `params`, however its key is spelled: `x.params`,
// `x["par" + "ams"]`, `const { params } = x`, `"params" in x`, or "params"
// handed to a call such as Reflect.get. Only the core touches
// `facts.params`: it lifts the bundle out before any Condition runs.
function paramsKeyReads(path: string, source: string): string[] {
  const file = parse(path, source);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const keys: (Constant | undefined)[] = ts.isPropertyAccessExpression(node)
      ? [node.name.text]
      : ts.isElementAccessExpression(node)
      ? [fold(node.argumentExpression)]
      : ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)
      ? [
          node.propertyName !== undefined
            ? propertyKey(node.propertyName)
            : ts.isIdentifier(node.name)
            ? node.name.text
            : undefined,
        ]
      : ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword
      ? [fold(node.left)]
      : ts.isCallExpression(node)
      ? node.arguments.map((arg) => fold(arg))
      : [];
    if (keys.includes("params")) {
      found.push(`${where(path)}:${lineOf(file, node)}: reads params`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// A params-shaped constant (an object with `value` and a `used_by` or `unit`)
// whose value holds a number. The fixture bundle's values are words.
function jsonParamValues(path: string, text: string): string[] {
  const found: string[] = [];
  const holdsNumber = (value: unknown): boolean =>
    typeof value === "number" ||
    (typeof value === "string" && DECIMAL.test(value)) ||
    (value !== null &&
      typeof value === "object" &&
      Object.values(value).some(holdsNumber));
  const walk = (value: unknown, key: string): void => {
    if (value === null || typeof value !== "object") {
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      "value" in record &&
      ("used_by" in record || "unit" in record) &&
      holdsNumber(record.value)
    ) {
      found.push(`${where(path)}: ${key} holds a number`);
    }
    for (const [name, child] of Object.entries(record)) {
      walk(child, key === "" ? name : `${key}.${name}`);
    }
  };
  walk(JSON.parse(text), "");
  return found;
}

// Every way a file can load another module: an import, an export from, an
// `import x = require()`, an inline `import()`, an import type, and any
// reference to `require`.
function moduleLoads(path: string, source: string): string[] {
  const file = parse(path, source);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) ||
      ts.isImportTypeNode(node) ||
      (ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
      (ts.isIdentifier(node) && node.text === "require")
    ) {
      found.push(`${where(path)}:${lineOf(file, node)}: loads a module`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("params boundary: no value reaches the public tree", function () {
  this.timeout(60000);

  it("no file under consult/ or mcp/ names or imports the service's generated params file", () => {
    const files = [
      ...filesUnder(join(REPO_ROOT, "consult"), () => true),
      ...filesUnder(join(REPO_ROOT, "mcp"), () => true),
    ];
    expect(files.length).to.be.greaterThan(10);
    const offenders = files.flatMap((path) =>
      generatedNameHits(path, readFileSync(path, "utf8"))
    );
    expect(offenders).to.deep.equal([]);
  });

  it("no source under consult/src spells a threshold, and no source under consult/ or mcp/ compares against one", () => {
    const files = [...tsUnder("consult/src"), ...tsUnder("mcp/src")];
    expect(files.map(where)).to.include(join("consult", "src", "catalog.ts"));
    const offenders = files.flatMap((path) =>
      thresholdLiterals(path, readFileSync(path, "utf8"))
    );
    expect(offenders).to.deep.equal([]);
  });

  it("no source under consult/src but the core reads a member named params", () => {
    const files = tsUnder("consult/src").filter(
      (path) => where(path) !== join("consult", "src", "core.ts")
    );
    expect(files.length).to.be.greaterThan(5);
    const offenders = files.flatMap((path) =>
      paramsKeyReads(path, readFileSync(path, "utf8"))
    );
    expect(offenders).to.deep.equal([]);
  });

  it("no JSON file under consult/ or mcp/ holds a params constant with a number, and the fixture bundle passes", () => {
    const files = [
      ...filesUnder(join(REPO_ROOT, "consult"), (path) =>
        path.endsWith(".json")
      ),
      ...filesUnder(join(REPO_ROOT, "mcp"), (path) => path.endsWith(".json")),
    ];
    expect(files).to.include(BUNDLE_PATH);
    const offenders = files.flatMap((path) =>
      jsonParamValues(path, readFileSync(path, "utf8"))
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

  it("the decoder's ABI declaration does not exempt other literals or comparisons", () => {
    const path = join(REPO_ROOT, "consult", "src", "monad-calldata.ts");
    expect(thresholdLiterals(path, "const riskLimit = 4999;")).to.have.length(
      1
    );
    expect(
      thresholdLiterals(path, "function check(n) { return n < 4999; }")
    ).not.to.deep.equal([]);
  });

  it("the public Monad chain ID exception does not admit a domain threshold", () => {
    const reader = join(
      REPO_ROOT,
      "mcp",
      "src",
      "readers",
      "registry-asset.ts"
    );
    expect(
      thresholdLiterals(reader, "if (base.chainNumber === 143) {}")
    ).to.deep.equal([]);
    expect(thresholdLiterals(reader, "if (holders === 143) {}")).to.have.length(
      1
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

  it("the threshold scan leaves structural code alone", () => {
    const catalog = join(REPO_ROOT, "consult", "src", "catalog.ts");
    const other = join(REPO_ROOT, "mcp", "src", "readers", "x.ts");
    for (const source of [
      'if (amount === "0") {}',
      "const bps = 10000 - 0;",
      "const n = BigInt(amount) * 10000n;",
      'const label = "fixture value, not a threshold";',
    ]) {
      expect(thresholdLiterals(catalog, source), source).to.deep.equal([]);
    }
    for (const source of [
      "const max = Math.max(a, b);",
      "if ((bytes[31] & 0x80) !== 0) {}",
      'if (value[i] === "1") {}',
      'if (text === "") {}',
      'if (prefix === "0x") {}',
    ]) {
      expect(thresholdLiterals(other, source), source).to.deep.equal([]);
    }
    const role = join(REPO_ROOT, "mcp", "src", "readers", "solana-role.ts");
    const pinned = 'if (body.jsonrpc !== "2.0") {}';
    expect(thresholdLiterals(role, pinned)).to.deep.equal([]);
    expect(thresholdLiterals(other, pinned)).to.have.length(1);
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
      thresholdLiterals(constants, 'export const HOLDERS_MIN = "4999";')
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

  it("every reviewed source name and comparison still exists where it is listed", () => {
    const stale = [
      ...Object.entries(SOURCE_NAMES).flatMap(([file, names]) => {
        const source = readFileSync(join(REPO_ROOT, file), "utf8");
        return names
          .filter(
            (name) =>
              !new RegExp(`^(export )?(const|function) ${name}\\b`, "m").test(
                source
              )
          )
          .map((name) => `${file}: ${name}`);
      }),
      ...[...REVIEWED_COMPARISONS].filter((entry) => {
        const [file, text] = entry.split(": ");
        return !readFileSync(join(REPO_ROOT, file), "utf8").includes(text);
      }),
    ];
    expect(stale).to.deep.equal([]);
  });
});

describe("params used-by check: a v1 Check reads only check or both constants", function () {
  it("every listed read names a check or both constant in the fixture bundle", () => {
    expect(paramReadViolations(PARAM_READS, BUNDLE)).to.deep.equal([]);
  });

  it("params.ts imports nothing, so the service loads it with no install", () => {
    const path = join(REPO_ROOT, "consult", "src", "params.ts");
    expect(moduleLoads(path, readFileSync(path, "utf8"))).to.deep.equal([]);
  });
});

// The eleven known leak shapes, then the shapes found in review since. 4999
// is an example number, not a real value. Each fixture must fail its scan.
const at = (...parts: string[]) => join(REPO_ROOT, ...parts);
const CATALOG = at("consult", "src", "catalog.ts");
const READER = at("mcp", "src", "readers", "x.ts");
const SERVICE = "../../../service/src/";
const LEAK_SHAPES: readonly (readonly [
  string,
  (path: string, source: string) => string[],
  string,
  string
])[] = [
  [
    "1 a literal in catalog.ts",
    thresholdLiterals,
    CATALOG,
    "const HOLDERS_MIN = 4999;",
  ],
  [
    "2 Number() of a string in catalog.ts",
    thresholdLiterals,
    CATALOG,
    'const HOLDERS_MIN = Number("4999");',
  ],
  [
    "3 BigInt() of a string in catalog.ts",
    thresholdLiterals,
    CATALOG,
    'const HOLDERS_MIN = BigInt("4999");',
  ],
  [
    "4 a sum of allowed numbers in catalog.ts",
    thresholdLiterals,
    CATALOG,
    "const HOLDERS_MIN = 10000 - 200 - 200;",
  ],
  [
    "5 a new consult/src file for the catalog to import",
    thresholdLiterals,
    at("consult", "src", "market.ts"),
    "export const HOLDERS_MIN = 4999;",
  ],
  [
    "6 named constants in a new consult/src file",
    thresholdLiterals,
    at("consult", "src", "thresholds.ts"),
    "export const SLIPPAGE_MAX_BPS = 4999; export const T = { holders: 4999 };",
  ],
  [
    "7 comparisons in an mcp reader",
    thresholdLiterals,
    READER,
    "const leak = h === 4999 || Math.min(h, 4999) === h || h - 4999 < 0;",
  ],
  [
    "7a an equality against a literal in an mcp reader",
    thresholdLiterals,
    READER,
    "const leak = h === 4999;",
  ],
  [
    "7b a Math.min bound in an mcp reader",
    thresholdLiterals,
    READER,
    "const leak = Math.min(h, 4999) === h;",
  ],
  [
    "7c arithmetic under a comparison in an mcp reader",
    thresholdLiterals,
    READER,
    "const leak = h - 4999 < 0;",
  ],
  [
    "8 a renamed .ts copy of the values",
    thresholdLiterals,
    at("consult", "src", "values.ts"),
    'export const params = { "defi-x": { "holders_min": { "value": 4999, "unit": "holders" } } } as const;',
  ],
  [
    "9 a JSON copy of the bundle",
    jsonParamValues,
    at("consult", "test", "fixtures", "real-params.json"),
    '{"defi-x":{"holders_min":{"value":4999,"unit":"holders","used_by":"check"}}}',
  ],
  [
    "10 a literal import of the generated file",
    generatedNameHits,
    at("consult", "src", "catalog.ts"),
    `import { params } from "${SERVICE}${GENERATED_NAME}";`,
  ],
  [
    "11 a split-string require of the generated file",
    generatedNameHits,
    at("consult", "src", "catalog.ts"),
    `require("${SERVICE}params" + ".generated");`,
  ],
  [
    "split computed key on facts",
    paramsKeyReads,
    CATALOG,
    'const leak = facts["par" + "ams"];',
  ],
  [
    "== against a literal",
    thresholdLiterals,
    READER,
    "const leak = holders == 4999;",
  ],
  [
    "!= against a literal",
    thresholdLiterals,
    READER,
    "const leak = holders != 4999;",
  ],
  [
    "!== against a literal",
    thresholdLiterals,
    READER,
    "const leak = holders !== 4999;",
  ],
  [
    "arithmetic on a compared literal",
    thresholdLiterals,
    READER,
    "const leak = holders < 4999 + 1;",
  ],
  [
    "import x = require() in params.ts",
    moduleLoads,
    at("consult", "src", "params.ts"),
    'import fs = require("node:fs");',
  ],
  [
    "an inline dynamic import in params.ts",
    moduleLoads,
    at("consult", "src", "params.ts"),
    'export const load = () => import("node:fs");',
  ],
  [
    "constant string concatenation of the generated name",
    generatedNameHits,
    at("mcp", "src", "readers", "x.ts"),
    'const name = "params" + ".generated";',
  ],
  [
    "a numeric string compared in an mcp reader",
    thresholdLiterals,
    READER,
    'const leak = holders >= "4999";',
  ],
  [
    "a hex string compared in an mcp reader",
    thresholdLiterals,
    READER,
    'const leak = holders >= "0x1387";',
  ],
  [
    "an octal string compared in an mcp reader",
    thresholdLiterals,
    READER,
    'const leak = holders >= "0o11607";',
  ],
  [
    "a binary string compared in an mcp reader",
    thresholdLiterals,
    READER,
    'const leak = holders >= "0b1001110000111";',
  ],
  [
    "a left shift on a compared value in an mcp reader",
    thresholdLiterals,
    READER,
    "const leak = (holders << 12) > 0;",
  ],
  [
    "a right shift on a compared value in an mcp reader",
    thresholdLiterals,
    READER,
    "const leak = (holders >> 12) > 0;",
  ],
  [
    "an unsigned right shift on a compared value in an mcp reader",
    thresholdLiterals,
    READER,
    "const leak = (holders >>> 12) > 0;",
  ],
  [
    "a bitwise or on a compared value in an mcp reader",
    thresholdLiterals,
    READER,
    "const leak = (holders | 4999) === holders;",
  ],
  [
    "a bitwise xor on a compared value in an mcp reader",
    thresholdLiterals,
    READER,
    "const leak = (holders ^ 4999) === 0;",
  ],
  [
    "a bitwise not on a compared value in an mcp reader",
    thresholdLiterals,
    READER,
    "const leak = ~(holders - 4999) < 0;",
  ],
  [
    "a bitwise and of hex strings in catalog.ts",
    thresholdLiterals,
    CATALOG,
    'const HOLDERS_MIN = "0x1387" & "0xffff";',
  ],
  [
    "a bitwise or of allowed numbers in catalog.ts",
    thresholdLiterals,
    CATALOG,
    "const HOLDERS_MIN = 200 | 1;",
  ],
  [
    "a bitwise xor of allowed numbers in catalog.ts",
    thresholdLiterals,
    CATALOG,
    "const HOLDERS_MIN = 200 ^ 1;",
  ],
  [
    "a left shift of allowed numbers in catalog.ts",
    thresholdLiterals,
    CATALOG,
    "const HOLDERS_MIN = 200 << 1;",
  ],
  [
    "a right shift of allowed numbers in catalog.ts",
    thresholdLiterals,
    CATALOG,
    "const HOLDERS_MIN = (10000 >> 1) - 1;",
  ],
  [
    "an unsigned right shift of allowed numbers in catalog.ts",
    thresholdLiterals,
    CATALOG,
    "const HOLDERS_MIN = (10000 >>> 1) - 1;",
  ],
  [
    "a bitwise not of allowed numbers in catalog.ts",
    thresholdLiterals,
    CATALOG,
    "const HOLDERS_MIN = ~1;",
  ],
  [
    "BigInt() of a hex string in catalog.ts",
    thresholdLiterals,
    CATALOG,
    'const HOLDERS_MIN = BigInt("0x1387");',
  ],
  [
    "a reviewed comparison copied into another mcp file",
    thresholdLiterals,
    READER,
    "if (response.status !== 200) {}",
  ],
  [
    "a reviewed source name reused in another consult/src file",
    thresholdLiterals,
    CATALOG,
    "const STATUS_RANK = 4999;",
  ],
  [
    "a template that folds to a number in catalog.ts",
    thresholdLiterals,
    CATALOG,
    'const HOLDERS_MIN = `49${""}99`;',
  ],
  [
    "an in check for the params key",
    paramsKeyReads,
    CATALOG,
    'const leak = "params" in facts;',
  ],
];

describe("params boundary: every known leak shape fails the scan", () => {
  for (const [label, scan, path, source] of LEAK_SHAPES) {
    it(label, () => {
      expect(scan(path, source), source).not.to.deep.equal([]);
    });
  }
});
