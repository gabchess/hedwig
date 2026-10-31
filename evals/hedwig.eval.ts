// Hedwig eval suite. Runs every labelled case in evals/cases.json through
// handleConsult, the same function the MCP server's consult tool calls, and
// scores the verdict. No model and no network: fetch is replaced by a stub
// that refuses and counts every call. Run it with `yarn evals`.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";

import { handleConsult } from "../mcp/src/handler";

type Verdict = "ALLOW_UNDER_POLICY" | "DENY" | "UNKNOWN";
type Json = Record<string, unknown>;

interface PolicySpec {
  from?: string;
  set?: Json;
  unset?: string[];
  text?: string;
  missing?: boolean;
}

interface TxSpec {
  payTo?: string;
  payAmount?: string;
  truncateHex?: number;
  set?: Json;
  unset?: string[];
}

interface EvalCase {
  id: string;
  category: string;
  description: string;
  policy?: string | PolicySpec;
  action?: Json;
  tx?: "auto" | "omit" | TxSpec;
  requestExtra?: Json;
  argsExtra?: Json;
  rawArgs?: unknown;
  padArgsBytes?: number;
  expected?: Verdict;
  anyOf?: Verdict[];
  basis: string;
}

interface CaseFile {
  addresses: { sender: string };
  policies: Record<string, Json>;
  baseActions: Record<string, Json>;
  cases: EvalCase[];
}

interface CaseResult {
  id: string;
  category: string;
  accepted: Verdict[];
  verdict: string;
  proceed: boolean;
  firstNonPassCode: string | null;
  pass: boolean;
}

const EVALS_DIR = __dirname;
const SUITE: CaseFile = JSON.parse(
  readFileSync(join(EVALS_DIR, "cases.json"), "utf8")
);
// Read once at load, before the suite clears HEDWIG_* variables. The inspect
// task sets it so its runs do not rewrite the committed results file.
const RESULTS_PATH =
  process.env.HEDWIG_EVALS_RESULTS ?? join(EVALS_DIR, "results.json");

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DIGITS = /^[0-9]+$/;
const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);

function accepted(c: EvalCase): Verdict[] {
  if (c.anyOf && c.anyOf.length > 0) return c.anyOf;
  if (c.expected) return [c.expected];
  throw new Error(`${c.id} has neither expected nor anyOf`);
}

function transferCalldata(recipient: string, amount: string): string {
  return (
    "0xa9059cbb" +
    recipient.slice(2).toLowerCase().padStart(64, "0") +
    BigInt(amount).toString(16).padStart(64, "0")
  );
}

function encodable(amount: unknown): amount is string {
  return (
    typeof amount === "string" &&
    DIGITS.test(amount) &&
    BigInt(amount) <= UINT256_MAX
  );
}

// The deadline "$now+N" is resolved at run time, so a swap's freshness check
// sees a deadline N seconds ahead of the handler's own clock.
function resolveNow(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("$now+")) {
    return Math.floor(Date.now() / 1000) + Number(value.slice(5));
  }
  return value;
}

function buildAction(c: EvalCase): Json {
  const type = String(
    (c.action?.type as string | undefined) ??
      (c.policy === "swap" ? "swap" : "pay")
  );
  const base = SUITE.baseActions[type === "swap" ? "swap" : "pay"];
  const action: Json = { ...base, ...(c.action ?? {}) };
  for (const [key, value] of Object.entries(action)) {
    if (value === null) delete action[key];
    else action[key] = resolveNow(value);
  }
  return action;
}

// For a pay, the default transaction is the ERC-20 transfer that matches the
// action. A field the case made malformed falls back to the base action's
// value, so the case still tests the field it set and not the encoder.
function buildTransaction(c: EvalCase, action: Json): Json | undefined {
  const mode = c.tx ?? (action.type === "swap" ? "omit" : "auto");
  if (mode === "omit") return undefined;
  const spec: TxSpec = mode === "auto" ? {} : mode;
  const base = SUITE.baseActions.pay;
  let tx: Json = {};
  if (action.type !== "swap") {
    const recipient =
      spec.payTo ??
      (typeof action.recipient === "string" && ADDRESS.test(action.recipient)
        ? action.recipient
        : (base.recipient as string));
    const amount =
      spec.payAmount ??
      (encodable(action.amount) ? action.amount : (base.amount as string));
    const target =
      typeof action.target === "string" ? action.target : base.target;
    tx = {
      from: SUITE.addresses.sender,
      to: target,
      value: "0",
      data: transferCalldata(recipient, amount),
    };
  }
  if (spec.truncateHex && typeof tx.data === "string") {
    tx.data = tx.data.slice(0, tx.data.length - spec.truncateHex);
  }
  Object.assign(tx, spec.set ?? {});
  for (const key of spec.unset ?? []) delete tx[key];
  return tx;
}

function buildArgs(c: EvalCase): unknown {
  if ("rawArgs" in c) return c.rawArgs;
  const action = buildAction(c);
  const transaction = buildTransaction(c, action);
  const request: Json = {
    action,
    ...(transaction ? { transaction } : {}),
    ...(c.requestExtra ?? {}),
  };
  const args: Json = { request, ...(c.argsExtra ?? {}) };
  if (c.padArgsBytes) {
    const size = Buffer.byteLength(JSON.stringify(args), "utf8");
    args.padding = "x".repeat(Math.max(0, c.padArgsBytes - size));
  }
  return args;
}

function writePolicy(c: EvalCase, dir: string): string {
  const path = join(dir, `${c.id}.policy.json`);
  const spec: PolicySpec =
    typeof c.policy === "string"
      ? { from: c.policy }
      : c.policy ?? { from: "pay" };
  if (spec.missing) return path;
  if (spec.text !== undefined) {
    writeFileSync(path, spec.text);
    return path;
  }
  const policy: Json = {
    ...SUITE.policies[spec.from ?? "pay"],
    ...(spec.set ?? {}),
  };
  for (const key of spec.unset ?? []) delete policy[key];
  writeFileSync(path, JSON.stringify(policy));
  return path;
}

function summarize(rows: CaseResult[]) {
  const byCategory: Record<
    string,
    { total: number; correct: number; accuracy: number }
  > = {};
  for (const row of rows) {
    const entry = (byCategory[row.category] ??= {
      total: 0,
      correct: 0,
      accuracy: 0,
    });
    entry.total += 1;
    if (row.pass) entry.correct += 1;
  }
  for (const entry of Object.values(byCategory)) {
    entry.accuracy = Number((entry.correct / entry.total).toFixed(4));
  }
  const correct = rows.filter((row) => row.pass).length;
  return {
    totalCases: rows.length,
    correct,
    accuracy: Number((correct / rows.length).toFixed(4)),
    // The safety number: proceed true on a case whose label is not ALLOW.
    wrongProceed: rows.filter(
      (row) => row.proceed && !row.accepted.includes("ALLOW_UNDER_POLICY")
    ).length,
    // The usability number: an ALLOW case that Hedwig stopped.
    overBlocked: rows.filter(
      (row) =>
        row.accepted.includes("ALLOW_UNDER_POLICY") &&
        row.verdict !== "ALLOW_UNDER_POLICY"
    ).length,
    casesWithAnyOfLabel: SUITE.cases.filter((c) => c.anyOf).length,
    byCategory,
  };
}

describe("Hedwig eval suite", function () {
  this.timeout(60_000);

  const rows: CaseResult[] = [];
  const savedEnv: Record<string, string | undefined> = {};
  const savedFetch = globalThis.fetch;
  let networkCalls = 0;
  let dir = "";
  let startedAt = 0;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-evals-"));
    // No owner RPC, registry or role settings: every Reader runs with no
    // configuration, the same as a fresh install with the sample policy.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("HEDWIG_")) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
    globalThis.fetch = (async () => {
      networkCalls += 1;
      throw new Error("the eval suite allows no network calls");
    }) as typeof fetch;
    startedAt = performance.now();
  });

  after(() => {
    const runtimeMs = Math.round(performance.now() - startedAt);
    globalThis.fetch = savedFetch;
    Object.assign(process.env, savedEnv);
    rmSync(dir, { recursive: true, force: true });
    const consultVersion = JSON.parse(
      readFileSync(join(EVALS_DIR, "..", "consult", "package.json"), "utf8")
    ).version;
    const report = {
      suite: "hedwig-evals",
      schemaVersion: 1,
      hedwigVersion: consultVersion,
      node: process.version,
      ranAt: new Date().toISOString(),
      runtimeMs,
      networkCalls,
      modelCalls: 0,
      ...summarize(rows),
      cases: rows,
    };
    writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2) + "\n");
    const lines = Object.entries(report.byCategory).map(
      ([name, entry]) =>
        `  ${name.padEnd(17)} ${entry.correct}/${entry.total}  ${(
          entry.accuracy * 100
        ).toFixed(1)}%`
    );
    console.log(
      [
        "",
        `Hedwig eval suite: ${report.correct}/${report.totalCases} correct (${(
          report.accuracy * 100
        ).toFixed(1)}%)`,
        ...lines,
        `  wrong proceed: ${report.wrongProceed}  over-blocked: ${report.overBlocked}`,
        `  runtime: ${runtimeMs} ms  network calls: ${networkCalls}  model calls: 0`,
        `  wrote ${RESULTS_PATH}`,
      ].join("\n")
    );
  });

  for (const c of SUITE.cases) {
    it(`${c.id} [${c.category}] ${c.description}`, async () => {
      const policyPath = writePolicy(c, dir);
      const response = await handleConsult(buildArgs(c), policyPath);
      const firstNonPass = response.results.find(
        (row) => row.status !== "PASS"
      );
      const row: CaseResult = {
        id: c.id,
        category: c.category,
        accepted: accepted(c),
        verdict: response.verdict,
        proceed: response.proceed,
        firstNonPassCode: firstNonPass?.code ?? null,
        // The same two conditions the expects below assert.
        pass:
          accepted(c).includes(response.verdict as Verdict) &&
          response.proceed === (response.verdict === "ALLOW_UNDER_POLICY"),
      };
      rows.push(row);
      expect(response.verdict, `${c.id}: ${c.basis}`).to.be.oneOf(row.accepted);
      expect(response.proceed).to.equal(
        response.verdict === "ALLOW_UNDER_POLICY"
      );
    });
  }

  it("made no network calls", () => {
    expect(networkCalls).to.equal(0);
  });
});
