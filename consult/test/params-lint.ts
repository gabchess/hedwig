// The used-by lint. A v1 Check may read only constants labelled `check` or
// `both`. The lint maps every constant a Condition reads to its label and
// fails on anything else. Public CI runs it against the fixture bundle; the
// service that supplies `facts.params` runs it against its own values. It
// imports `typescript`, so that service needs the compiler installed.
//
// How it works. Each source is parsed with the TypeScript compiler API, so a
// cast, a parenthesis, an escape (`"\x70arams"`, `\u0070arams`), a comment or
// a quote inside a template or regex cannot change what the lint sees. Three
// values are tracked by name, flow-insensitively, across every file passed in:
//   F  `facts`: an identifier, parameter or variable named `facts`, any
//      `.facts` or `["facts"]` read, `Reflect.get(x, "facts")`, an alias of
//      one (`const f = facts`, `const { facts: g } = context`), or a
//      parameter that receives one in a call to a function declared in the
//      scanned files.
//   C  a container of `facts`: an identifier named `context`, a parameter
//      typed `ConditionContext`, or an object literal with a `facts`
//      property.
//   P  `facts.params`.
// A P value may appear only as the first argument of a `checkParam` call, whose
// id and key must be string literals and are checked against the bundle. Every
// other P is a problem. A read of F or C fails closed unless its key is one
// string literal: a computed key, a spread, a rest or array destructuring, a
// `for...in` or `for...of`, and a call that hands F or C to a function the
// lint cannot follow (`Object.keys`, `JSON.stringify`, `Object.assign`, an
// imported helper, `.call` or `.apply`) are all problems. `Reflect` may appear
// only as a direct `Reflect.get` call. A helper that reads
// `source[key]` from two of its own parameters (`ownLookup`) is checked at each
// call site instead: a tracked value with a non-literal key is a problem.
// `arguments`, `eval`, `Function`, `globalThis`, `global`, `self`, `window` and
// a `with` statement are problems wherever they appear, and so is a tracked
// value passed to a rest parameter. A source that does not parse is a
// problem.
//
// Limits. This is a name-based flow analysis, not a type checker.
//   - A value reaches the lint only through the names above. `facts` read
//     through an object under another name and a non-literal key
//     (`holder[k]`, or `ctx[k]` where `ctx` is neither named `context` nor
//     typed `ConditionContext`), a getter or a Proxy is not tracked.
//   - Calls resolve by name. A function value passed as an argument, a
//     re-exported or renamed import (`import { f as g }`) and a callee
//     chosen at run time are unresolved, so tracked arguments to them fail
//     closed, but a tracked value they return is not tracked.
//   - The names in OPAQUE_FUNCTIONS and OPAQUE_CALLEES below are the engine
//     plumbing that moves `facts` without reading it. The lint trusts those
//     names where they are declared and does not read their bodies for a read
//     of `facts`; a person reviews a change to them.
// Closing the rest needs `params` out of `context.facts`, with its own channel
// for `checkParam`.

import * as ts from "typescript";

const C = 1;
const F = 2;
const P = 4;
type Mask = number;

// Engine functions that carry `facts` without reading a key from it. A call
// that resolves to one of these declarations is not followed.
// `returns: "same"` means the result is its argument, so it is still tracked.
export const OPAQUE_FUNCTIONS: ReadonlyArray<{
  file: string;
  name: string;
  returns: "same" | "none";
}> = [
  { file: "consult/src/catalog.ts", name: "deepFreeze", returns: "same" },
  { file: "consult/src/core.ts", name: "isOversized", returns: "none" },
];
// A callee with no declaration to resolve: a parameter, or an interface
// member that the catalog fills with other files' functions. Matched by name
// inside the named file only. `definition.check` hands `{ policy, facts }` to
// a Condition, whose own `context.facts` reads the lint scans where they are
// written.
export const OPAQUE_CALLEES: ReadonlyArray<{ file: string; name: string }> = [
  { file: "consult/src/guard-internal.ts", name: "consultFn" },
  { file: "consult/src/core.ts", name: "check" },
];

// Built-ins by dotted name. `PRESENCE` tests a key or a type and returns no
// part of the value; `SAME` returns its argument.
const PRESENCE = new Set([
  "Object.hasOwn",
  "Array.isArray",
  "Object.prototype.hasOwnProperty.call",
]);
const SAME = new Set(["structuredClone", "Object.freeze"]);
const BANNED_NAMES = new Set([
  "arguments",
  "eval",
  "Function",
  "globalThis",
  "global",
  "self",
  "window",
]);
const CHECK_READABLE = ["check", "both"];

type Fn = ts.FunctionLikeDeclaration;
type Transparent =
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.SatisfiesExpression
  | ts.TypeAssertion
  | ts.NonNullExpression
  | ts.AwaitExpression;

const isTransparent = (n: ts.Node): n is Transparent =>
  ts.isParenthesizedExpression(n) ||
  ts.isAsExpression(n) ||
  ts.isSatisfiesExpression(n) ||
  ts.isTypeAssertionExpression(n) ||
  ts.isNonNullExpression(n) ||
  ts.isAwaitExpression(n);

function strip(node: ts.Node): ts.Node {
  let n = node;
  while (isTransparent(n)) {
    n = n.expression;
  }
  return n;
}

// The text of a key that is one string or number literal, else undefined.
function literalKey(e: ts.Node | undefined): string | undefined {
  if (e === undefined) {
    return undefined;
  }
  const n = strip(e);
  return ts.isStringLiteralLike(n) || ts.isNumericLiteral(n)
    ? n.text
    : undefined;
}

function keyText(name: ts.Node): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return ts.isComputedPropertyName(name)
    ? literalKey(name.expression)
    : undefined;
}

function calleeName(callee: ts.Node): string | undefined {
  const c = strip(callee);
  if (ts.isIdentifier(c)) {
    return c.text;
  }
  if (ts.isPropertyAccessExpression(c)) {
    return c.name.text;
  }
  return ts.isElementAccessExpression(c)
    ? literalKey(c.argumentExpression)
    : undefined;
}

// `Object.hasOwn`, `Reflect["get"]`, `a?.b.c`: the dotted name of a chain of
// identifiers and literal keys, else undefined.
function dotted(node: ts.Node): string | undefined {
  const n = strip(node);
  if (ts.isIdentifier(n)) {
    return n.text;
  }
  const key = ts.isPropertyAccessExpression(n)
    ? n.name.text
    : ts.isElementAccessExpression(n)
    ? literalKey(n.argumentExpression)
    : undefined;
  if (key === undefined) {
    return undefined;
  }
  const head = dotted(
    ts.isPropertyAccessExpression(n)
      ? n.expression
      : (n as ts.ElementAccessExpression).expression
  );
  return head === undefined ? undefined : `${head}.${key}`;
}

const readMask = (m: Mask, key: string): Mask =>
  (key === "facts" ? F : 0) | (m & F && key === "params" ? P : 0);

// The name slots of declarations. An identifier there is not a value read.
function isValueRef(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p)) {
    return p.expression === id;
  }
  if (
    ts.isQualifiedName(p) ||
    ts.isMetaProperty(p) ||
    ts.isLabeledStatement(p) ||
    ts.isBreakOrContinueStatement(p)
  ) {
    return false;
  }
  if (ts.isShorthandPropertyAssignment(p)) {
    return true;
  }
  const slots = p as { name?: ts.Node; propertyName?: ts.Node };
  return !(
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isTypeParameterDeclaration(p) ||
      ts.isModuleDeclaration(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isImportSpecifier(p) ||
      ts.isExportSpecifier(p) ||
      ts.isNamespaceImport(p) ||
      ts.isImportClause(p) ||
      ts.isImportEqualsDeclaration(p)) &&
    (slots.name === id || slots.propertyName === id)
  );
}

// A parameter typed `ConditionContext` holds facts whatever it is called.
const isContextType = (type: ts.TypeNode | undefined): boolean =>
  type !== undefined &&
  ts.isTypeReferenceNode(type) &&
  (ts.isIdentifier(type.typeName)
    ? type.typeName.text
    : type.typeName.right.text) === "ConditionContext";

// Types and imports hold no run-time read.
const isNotCode = (n: ts.Node): boolean =>
  ts.isTypeNode(n) ||
  ts.isImportDeclaration(n) ||
  ts.isInterfaceDeclaration(n) ||
  ts.isTypeAliasDeclaration(n);

const hasBody = (n: ts.Node): n is Fn =>
  ts.isFunctionLike(n) && (n as Fn).body !== undefined;

function enclosingFn(n: ts.Node): Fn | undefined {
  for (let a = n.parent; a; a = a.parent) {
    if (hasBody(a)) {
      return a;
    }
  }
  return undefined;
}

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) {
      bindingNames(el.name, out);
    }
  }
}

// The name a function is known by: its own, its variable's, or its property's.
function fnName(fn: Fn): string | undefined {
  if (
    (ts.isFunctionDeclaration(fn) ||
      ts.isMethodDeclaration(fn) ||
      ts.isFunctionExpression(fn)) &&
    fn.name
  ) {
    return keyText(fn.name);
  }
  let top: ts.Node = fn;
  while (top.parent && isTransparent(top.parent)) {
    top = top.parent;
  }
  const p = top.parent;
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p)) &&
    p.initializer === top
  ) {
    return keyText(p.name);
  }
  return undefined;
}

interface Unit {
  file: string;
  sf: ts.SourceFile;
}

interface Found {
  file: string;
  line: number;
  why: string;
}

interface Call {
  file: string;
  line: number;
  id?: string;
  key?: string;
}

// Parse errors fail closed. `parseDiagnostics` is not in the public typings.
const parseErrors = (sf: ts.SourceFile): number =>
  (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics
    ?.length ?? 0;

function analyze(units: Unit[]): { found: Found[]; calls: Call[] } {
  const fileOf = new Map(units.map((u) => [u.sf, u.file]));
  const file = (n: ts.Node): string => fileOf.get(n.getSourceFile()) ?? "";
  const ids = new Map<ts.Node, number>();
  const idOf = (n: ts.Node): number => {
    let id = ids.get(n);
    if (id === undefined) {
      id = ids.size;
      ids.set(n, id);
    }
    return id;
  };
  const sameFile = (path: string, spec: string): boolean => {
    const p = path.split("\\").join("/");
    return p === spec || p.endsWith(`/${spec}`);
  };

  // Scopes. Block scoping is ignored: a name belongs to its function.
  const declCache = new Map<ts.Node, Set<string>>();
  const declared = (scope: ts.Node): Set<string> => {
    const cached = declCache.get(scope);
    if (cached) {
      return cached;
    }
    const names = new Set<string>();
    declCache.set(scope, names);
    if (ts.isFunctionLike(scope)) {
      for (const param of scope.parameters) {
        bindingNames(param.name, names);
      }
    }
    const walk = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n)) {
        bindingNames(n.name, names);
      } else if (
        (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) &&
        n.name
      ) {
        names.add(n.name.text);
      } else if ((ts.isImportClause(n) || ts.isNamespaceImport(n)) && n.name) {
        names.add(n.name.text);
      } else if (ts.isImportSpecifier(n)) {
        names.add(n.name.text);
      }
      if (!ts.isFunctionLike(n)) {
        ts.forEachChild(n, walk);
      }
    };
    if (ts.isSourceFile(scope)) {
      ts.forEachChild(scope, walk);
    } else if (hasBody(scope)) {
      walk(scope.body as ts.Node);
    }
    return names;
  };
  const scopeKey = (id: ts.Identifier): string => {
    for (let a: ts.Node | undefined = id.parent; a; a = a.parent) {
      if (
        (ts.isFunctionLike(a) || ts.isSourceFile(a)) &&
        declared(a).has(id.text)
      ) {
        return `${idOf(a)}:${id.text}`;
      }
    }
    return `global:${id.text}`;
  };

  // Every function with a body, by name.
  const fns = new Map<string, Fn[]>();
  const everyNode: ts.Node[] = [];
  for (const u of units) {
    const collect = (n: ts.Node): void => {
      if (isNotCode(n)) {
        return;
      }
      everyNode.push(n);
      if (hasBody(n)) {
        const name = fnName(n);
        if (name !== undefined) {
          fns.set(name, [...(fns.get(name) ?? []), n]);
        }
      }
      ts.forEachChild(n, collect);
    };
    collect(u.sf);
  }
  const isOpaqueFn = (fn: Fn): boolean =>
    OPAQUE_FUNCTIONS.some(
      (o) => o.name === fnName(fn) && sameFile(file(fn), o.file)
    );

  // A helper that reads `source[key]` from two of its own parameters.
  const keyed = new Map<Fn, Array<{ i: number; j: number }>>();
  const paramIndex = (fn: Fn, id: ts.Identifier): number =>
    scopeKey(id) === `${idOf(fn)}:${id.text}`
      ? fn.parameters.findIndex(
          (p) => ts.isIdentifier(p.name) && p.name.text === id.text
        )
      : -1;
  const reassigned = (fn: Fn, name: string): boolean => {
    let hit = false;
    const walk = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const left = strip(n.left);
        hit = hit || (ts.isIdentifier(left) && left.text === name);
      }
      ts.forEachChild(n, walk);
    };
    walk(fn.body as ts.Node);
    return hit;
  };
  const parametricRead = (
    e: ts.ElementAccessExpression
  ): { fn: Fn; i: number; j: number } | undefined => {
    const fn = enclosingFn(e);
    const recv = strip(e.expression);
    const key = strip(e.argumentExpression);
    if (!fn || !ts.isIdentifier(recv) || !ts.isIdentifier(key)) {
      return undefined;
    }
    const i = paramIndex(fn, recv);
    const j = paramIndex(fn, key);
    return i >= 0 && j >= 0 && i !== j && !reassigned(fn, key.text)
      ? { fn, i, j }
      : undefined;
  };
  for (const n of everyNode) {
    if (
      ts.isElementAccessExpression(n) &&
      literalKey(n.argumentExpression) === undefined
    ) {
      const read = parametricRead(n);
      if (read) {
        keyed.set(read.fn, [...(keyed.get(read.fn) ?? []), read]);
      }
    }
  }

  // What a call resolves to.
  type Callee =
    | { kind: "reflect" | "presence" | "same" | "checkParam" | "unknown" }
    | { kind: "fns"; fns: Fn[]; opaque: boolean; opaqueSame: boolean };
  const classify = (call: ts.CallExpression): Callee => {
    const d = dotted(call.expression)?.replace(/^globalThis\./, "");
    if (d === "Reflect.get") {
      return { kind: "reflect" };
    }
    if (d !== undefined && PRESENCE.has(d)) {
      return { kind: "presence" };
    }
    if (d !== undefined && SAME.has(d)) {
      return { kind: "same" };
    }
    const name = calleeName(call.expression);
    if (name === "checkParam") {
      return { kind: "checkParam" };
    }
    if (name === undefined) {
      return { kind: "unknown" };
    }
    const all = fns.get(name) ?? [];
    const opaqueDecls = all.filter(isOpaqueFn);
    const calledOpaque = OPAQUE_CALLEES.some(
      (o) => o.name === name && sameFile(file(call), o.file)
    );
    const normal = all.filter((f) => !isOpaqueFn(f));
    if (normal.length === 0 && opaqueDecls.length === 0 && !calledOpaque) {
      return { kind: "unknown" };
    }
    return {
      kind: "fns",
      fns: normal,
      opaque: opaqueDecls.length > 0 || calledOpaque,
      opaqueSame: opaqueDecls.some((f) =>
        OPAQUE_FUNCTIONS.some(
          (o) =>
            o.returns === "same" &&
            o.name === fnName(f) &&
            sameFile(file(f), o.file)
        )
      ),
    };
  };

  // The flow state. Only F and C are stored: a P is reported where it is read.
  const env = new Map<string, Mask>();
  const returns = new Map<Fn, Mask>();
  const patternParams = new Map<ts.ParameterDeclaration, Mask>();
  let changed = false;
  const store = (m: Mask): Mask => m & ~P;
  const addTo = <K>(map: Map<K, Mask>, key: K, m: Mask): void => {
    const before = map.get(key) ?? 0;
    const after = before | store(m);
    if (after !== before) {
      map.set(key, after);
      changed = true;
    }
  };

  const level = (n: ts.Node): Mask => {
    if (isTransparent(n)) {
      return level(n.expression);
    }
    if (ts.isIdentifier(n)) {
      if (!isValueRef(n)) {
        return 0;
      }
      return (
        (n.text === "facts" ? F : n.text === "context" ? C : 0) |
        (env.get(scopeKey(n)) ?? 0)
      );
    }
    if (ts.isPropertyAccessExpression(n)) {
      return readMask(level(n.expression), n.name.text);
    }
    if (ts.isElementAccessExpression(n)) {
      const key = literalKey(n.argumentExpression);
      return key === undefined ? 0 : readMask(level(n.expression), key);
    }
    if (ts.isCallExpression(n)) {
      return callLevel(n);
    }
    if (ts.isBinaryExpression(n)) {
      switch (n.operatorToken.kind) {
        case ts.SyntaxKind.AmpersandAmpersandToken:
        case ts.SyntaxKind.BarBarToken:
        case ts.SyntaxKind.QuestionQuestionToken:
          return level(n.left) | level(n.right);
        case ts.SyntaxKind.CommaToken:
        case ts.SyntaxKind.EqualsToken:
          return level(n.right);
        default:
          return 0;
      }
    }
    if (ts.isConditionalExpression(n)) {
      return level(n.whenTrue) | level(n.whenFalse);
    }
    if (ts.isObjectLiteralExpression(n)) {
      return n.properties.some(
        (p) =>
          (ts.isShorthandPropertyAssignment(p) && p.name.text === "facts") ||
          (ts.isPropertyAssignment(p) &&
            keyText(p.name) === "facts" &&
            level(p.initializer) & F)
      )
        ? C
        : 0;
    }
    return 0;
  };
  const callLevel = (n: ts.CallExpression): Mask => {
    const callee = classify(n);
    const args = n.arguments;
    if (callee.kind === "reflect") {
      const key = literalKey(args[1]);
      return key === undefined || args[0] === undefined
        ? 0
        : readMask(level(args[0]), key);
    }
    if (callee.kind === "same") {
      return args[0] === undefined ? 0 : level(args[0]);
    }
    if (callee.kind !== "fns") {
      return 0;
    }
    let m = callee.opaqueSame && args[0] !== undefined ? level(args[0]) : 0;
    for (const fn of callee.fns) {
      m |= returns.get(fn) ?? 0;
      for (const { i, j } of keyed.get(fn) ?? []) {
        const key = literalKey(args[j]);
        if (key !== undefined && args[i] !== undefined) {
          m |= readMask(level(args[i]), key);
        }
      }
    }
    return m;
  };

  // Destructuring. `bind` receives each bound name and its mask; `flag`
  // receives each read the lint refuses.
  const pattern = (
    name: ts.BindingName,
    m: Mask,
    bind: (id: ts.Identifier, m: Mask) => void,
    flag: (n: ts.Node, why: string) => void
  ): void => {
    if (ts.isIdentifier(name)) {
      bind(name, m);
      return;
    }
    const tracked = m & (C | F);
    if (ts.isArrayBindingPattern(name)) {
      if (tracked) {
        flag(name, "destructures facts by position");
      }
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) {
          pattern(el.name, tracked, bind, flag);
        }
      }
      return;
    }
    for (const el of name.elements) {
      const key = el.propertyName
        ? keyText(el.propertyName)
        : ts.isIdentifier(el.name)
        ? el.name.text
        : undefined;
      let sub: Mask = 0;
      if (tracked && el.dotDotDotToken) {
        flag(el, "rest-destructures facts");
      } else if (tracked && key === undefined) {
        flag(el, "destructures facts with a key the lint cannot resolve");
      } else if (tracked && m & F && key === "params") {
        flag(el, "reads facts.params outside checkParam");
      } else if (key !== undefined) {
        // `{ facts: z }` names facts on any receiver, tracked or not.
        sub = readMask(m, key);
      }
      const withDefault = sub | (el.initializer ? level(el.initializer) : 0);
      pattern(el.name, withDefault, bind, flag);
    }
  };
  const bindEnv = (id: ts.Identifier, m: Mask): void =>
    addTo(env, scopeKey(id), m);
  const noFlag = (): void => undefined;

  const flowOne = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      pattern(n.name, level(n.initializer), bindEnv, noFlag);
    } else if (ts.isParameter(n)) {
      const incoming =
        (patternParams.get(n) ?? 0) |
        (n.initializer ? level(n.initializer) : 0) |
        (isContextType(n.type) ? C : 0);
      pattern(n.name, incoming, bindEnv, noFlag);
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = strip(n.left);
      if (ts.isIdentifier(left)) {
        addTo(env, scopeKey(left), level(n.right));
      }
    } else if (ts.isReturnStatement(n) && n.expression) {
      const fn = enclosingFn(n);
      if (fn) {
        addTo(returns, fn, level(n.expression));
      }
    } else if (ts.isArrowFunction(n) && !ts.isBlock(n.body)) {
      addTo(returns, n, level(n.body));
    } else if (ts.isCallExpression(n)) {
      const callee = classify(n);
      if (callee.kind !== "fns") {
        return;
      }
      for (const fn of callee.fns) {
        n.arguments.forEach((arg, i) => {
          const param = fn.parameters[i];
          if (ts.isSpreadElement(arg) || !param || param.dotDotDotToken) {
            return;
          }
          const m = level(arg);
          if (ts.isIdentifier(param.name)) {
            addTo(env, scopeKey(param.name), m);
          } else {
            addTo(patternParams, param, m);
          }
        });
      }
    }
  };
  for (let round = 0; round < 50; round++) {
    changed = false;
    everyNode.forEach(flowOne);
    if (!changed) {
      break;
    }
  }

  // The report pass.
  const found: Found[] = [];
  const calls: Call[] = [];
  const seen = new Set<string>();
  const flag = (n: ts.Node, why: string): void => {
    const line =
      n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;
    const key = `${file(n)}:${line}:${why}`;
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ file: file(n), line, why });
    }
  };

  // Climb through nodes that pass a value on unchanged.
  const passThrough = (n: ts.Node): ts.Node => {
    let top = n;
    for (;;) {
      const p = top.parent;
      if (
        isTransparent(p) ||
        (ts.isBinaryExpression(p) &&
          (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            p.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
            p.operatorToken.kind === ts.SyntaxKind.CommaToken)) ||
        (ts.isConditionalExpression(p) && p.condition !== top)
      ) {
        top = p;
      } else {
        return top;
      }
    }
  };
  const isCheckParamArg0 = (n: ts.Node): boolean => {
    const top = passThrough(n);
    const p = top.parent;
    return (
      ts.isCallExpression(p) &&
      p.arguments[0] === top &&
      calleeName(p.expression) === "checkParam"
    );
  };

  const argProblem = (
    n: ts.Node,
    call: ts.CallExpression
  ): string | undefined => {
    if (call.arguments.some(ts.isSpreadElement)) {
      return "passes facts to a call with a spread argument";
    }
    const callee = classify(call);
    switch (callee.kind) {
      case "reflect":
        return call.arguments[0] === n
          ? undefined
          : "passes facts to Reflect.get as a key or receiver";
      case "presence":
      case "same":
      case "fns":
        return undefined;
      case "checkParam":
        return "passes facts to checkParam; only facts.params belongs there";
      default:
        return "hands facts to a function the lint cannot follow";
    }
  };
  const useProblem = (n: ts.Node): string | undefined => {
    const p = n.parent;
    if (
      isTransparent(p) ||
      ts.isPropertyAccessExpression(p) ||
      ts.isElementAccessExpression(p) ||
      ts.isConditionalExpression(p) ||
      ts.isPrefixUnaryExpression(p) ||
      ts.isPostfixUnaryExpression(p) ||
      ts.isTypeOfExpression(p) ||
      ts.isVoidExpression(p) ||
      ts.isDeleteExpression(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p) ||
      ts.isReturnStatement(p) ||
      ts.isArrowFunction(p) ||
      ts.isExpressionStatement(p) ||
      ts.isIfStatement(p) ||
      ts.isWhileStatement(p) ||
      ts.isDoStatement(p) ||
      ts.isForStatement(p) ||
      ts.isSwitchStatement(p) ||
      ts.isCaseClause(p) ||
      ts.isThrowStatement(p)
    ) {
      return undefined;
    }
    if (ts.isBinaryExpression(p)) {
      if (p.operatorToken.kind !== ts.SyntaxKind.EqualsToken || p.right !== n) {
        return undefined;
      }
      const left = strip(p.left);
      const into =
        ts.isIdentifier(left) ||
        (ts.isPropertyAccessExpression(left) && left.name.text === "facts") ||
        (ts.isElementAccessExpression(left) &&
          literalKey(left.argumentExpression) === "facts");
      return into ? undefined : "stores facts where the lint cannot follow it";
    }
    if (ts.isCallExpression(p)) {
      return p.expression === n ? undefined : argProblem(n, p);
    }
    if (ts.isNewExpression(p)) {
      return p.expression === n
        ? undefined
        : "hands facts to a constructor the lint cannot follow";
    }
    if (ts.isPropertyAssignment(p)) {
      return keyText(p.name) === "facts"
        ? undefined
        : "copies facts into another object";
    }
    if (ts.isShorthandPropertyAssignment(p)) {
      return p.name.text === "facts"
        ? undefined
        : "copies facts into another object";
    }
    if (ts.isTemplateSpan(p)) {
      return ts.isTaggedTemplateExpression(p.parent.parent)
        ? "hands facts to a template tag"
        : undefined;
    }
    if (ts.isForInStatement(p) || ts.isForOfStatement(p)) {
      return "enumerates facts";
    }
    if (ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) {
      return "spreads facts";
    }
    return "uses facts in a form the lint does not model";
  };

  const isDirectReflectGet = (id: ts.Identifier): boolean => {
    const a = id.parent;
    const get =
      (ts.isPropertyAccessExpression(a) &&
        a.expression === id &&
        a.name.text === "get") ||
      (ts.isElementAccessExpression(a) &&
        a.expression === id &&
        literalKey(a.argumentExpression) === "get");
    if (!get) {
      return false;
    }
    let top: ts.Node = a;
    while (isTransparent(top.parent)) {
      top = top.parent;
    }
    return ts.isCallExpression(top.parent) && top.parent.expression === top;
  };

  const visit = (n: ts.Node): void => {
    if (isNotCode(n)) {
      return;
    }
    if (ts.isWithStatement(n)) {
      flag(n, "uses `with`, which hides a read of facts");
    }
    if (ts.isIdentifier(n)) {
      if (!isValueRef(n)) {
        return;
      }
      if (BANNED_NAMES.has(n.text)) {
        flag(n, `reads \`${n.text}\`, which hides a read of facts`);
      }
      if (n.text === "Reflect" && !isDirectReflectGet(n)) {
        flag(n, "uses Reflect other than a direct Reflect.get call");
      }
    }
    const m = level(n);
    if (m & P && !isCheckParamArg0(n)) {
      if (
        ts.isIdentifier(n) ||
        ts.isPropertyAccessExpression(n) ||
        ts.isElementAccessExpression(n) ||
        ts.isCallExpression(n)
      ) {
        flag(n, "reads facts.params outside a checkParam call");
      }
    }
    if (m & (C | F) && (ts.isIdentifier(n) || ts.isExpression(n))) {
      const why = useProblem(n);
      if (why !== undefined) {
        flag(n, why);
      }
    }
    if (ts.isElementAccessExpression(n)) {
      if (
        level(n.expression) & (C | F) &&
        literalKey(n.argumentExpression) === undefined &&
        !parametricRead(n)
      ) {
        flag(n, "reads facts with a key the lint cannot resolve");
      }
    }
    if (
      (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) &&
      n.name?.text === "checkParam"
    ) {
      flag(n, "declares its own checkParam");
    }
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "checkParam"
    ) {
      flag(n, "declares its own checkParam");
    }
    if (ts.isCallExpression(n)) {
      const callee = classify(n);
      const args = n.arguments;
      if (
        callee.kind === "presence" &&
        args[0] !== undefined &&
        level(args[0]) & F &&
        literalKey(args[1]) === "params"
      ) {
        flag(n, "tests for facts.params");
      }
      if (callee.kind === "reflect") {
        if (
          args[0] !== undefined &&
          level(args[0]) & (C | F) &&
          literalKey(args[1]) === undefined
        ) {
          flag(
            n,
            "reads facts through Reflect.get with a key the lint cannot resolve"
          );
        }
      } else if (callee.kind === "fns") {
        for (const fn of callee.fns) {
          const rest = fn.parameters.findIndex((q) => q.dotDotDotToken);
          if (rest >= 0 && args.slice(rest).some((a) => level(a) & (C | F))) {
            flag(n, "passes facts to a rest parameter");
          }
          for (const { i, j } of keyed.get(fn) ?? []) {
            if (
              args[i] !== undefined &&
              level(args[i]) & (C | F) &&
              literalKey(args[j]) === undefined
            ) {
              flag(
                n,
                "reads facts through a helper with a key the lint cannot resolve"
              );
            }
          }
        }
      } else if (callee.kind === "checkParam") {
        const id = literalKey(args[1]);
        const key = literalKey(args[2]);
        const line =
          n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line +
          1;
        const literal =
          args.length === 3 &&
          ts.isStringLiteralLike(strip(args[1])) &&
          ts.isStringLiteralLike(strip(args[2]));
        calls.push(
          literal ? { file: file(n), line, id, key } : { file: file(n), line }
        );
      }
    }
    if ((ts.isVariableDeclaration(n) && n.initializer) || ts.isParameter(n)) {
      const incoming = ts.isParameter(n)
        ? (patternParams.get(n) ?? 0) |
          (n.initializer ? level(n.initializer) : 0)
        : level((n as ts.VariableDeclaration).initializer as ts.Node);
      if (!ts.isIdentifier(n.name)) {
        pattern(n.name, incoming, noFlag, flag);
      }
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      literalKey(n.left) === "params" &&
      level(n.right) & F
    ) {
      flag(n, "tests for facts.params");
    }
    ts.forEachChild(n, visit);
  };
  for (const u of units) {
    for (const stmt of u.sf.statements) {
      const bindings =
        ts.isImportDeclaration(stmt) && stmt.importClause?.namedBindings;
      if (
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some(
          (el) => (el.propertyName ?? el.name).text === "checkParam"
        ) &&
        !/(^|\/)params$/.test(
          (stmt as ts.ImportDeclaration).moduleSpecifier.getText().slice(1, -1)
        )
      ) {
        flag(stmt, "imports checkParam from a module other than params");
      }
    }
    visit(u.sf);
  }
  return { found, calls };
}

function labelOf(params: unknown, id: string, key: string): unknown {
  if (params === null || typeof params !== "object") {
    return undefined;
  }
  const file = Object.prototype.hasOwnProperty.call(params, id)
    ? (params as Record<string, unknown>)[id]
    : undefined;
  if (file === null || typeof file !== "object") {
    return undefined;
  }
  const constant = Object.prototype.hasOwnProperty.call(file, key)
    ? (file as Record<string, unknown>)[key]
    : undefined;
  if (constant === null || typeof constant !== "object") {
    return undefined;
  }
  return (constant as Record<string, unknown>).used_by;
}

// `sources` maps a file name to its source text. Pass every file of the tree
// together: calls are resolved across files by name. Returns one line per
// problem; an empty list passes.
export function usedByViolations(
  sources: Record<string, string>,
  params: unknown
): string[] {
  const units: Unit[] = Object.entries(sources).map(([file, text]) => ({
    file,
    sf: ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    ),
  }));
  const problems: string[] = [];
  const unparsed = new Set(
    units.filter((u) => parseErrors(u.sf) > 0).map((u) => u.file)
  );
  const parsed = units.filter((u) => !unparsed.has(u.file));
  const { found, calls } = analyze(parsed);
  for (const file of Object.keys(sources)) {
    if (unparsed.has(file)) {
      problems.push(`${file}: does not parse, so it cannot be linted`);
      continue;
    }
    for (const call of calls.filter((c) => c.file === file)) {
      if (call.id === undefined || call.key === undefined) {
        problems.push(
          `${file}:${call.line}: checkParam call without a literal params id and key`
        );
        continue;
      }
      const label = labelOf(params, call.id, call.key);
      if (typeof label !== "string") {
        problems.push(
          `${file}: reads ${call.id} ${call.key}, which has no used_by label`
        );
      } else if (!CHECK_READABLE.includes(label)) {
        problems.push(
          `${file}: reads ${call.id} ${call.key}, labelled ${label}`
        );
      }
    }
    for (const f of found.filter((x) => x.file === file)) {
      problems.push(
        `${file}:${f.line}: touches params outside a checkParam call (${f.why})`
      );
    }
  }
  return problems;
}
