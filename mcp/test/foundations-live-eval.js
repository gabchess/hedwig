#!/usr/bin/env node
"use strict";

const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { createReportWriter } = require("./live-eval-report");
const {
  captureEvidenceBinding,
  evidenceBindingsMatch,
  parseProviderDiagnostic,
  parseBudgetDiagnostic,
} = require("./live-eval-evidence");

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const KEY_USAGE_URL = "https://openrouter.ai/api/v1/key";
const LIVE_REQUEST_TIMEOUT_MS = 10_000;
const BETWEEN_CASES_MS = 60_000;
const PAID_BETWEEN_CASES_MS = 1_000;
const PROVIDER_DIAGNOSTIC_TIMEOUT_MS = 1_000;
const STOP_REASONS = new Set([
  "configuration_missing_or_invalid",
  "fixture_invalid",
  "build_missing",
  "price_qualification_failed",
  "usage_measurement_unavailable",
  "server_or_protocol_unavailable",
  "model_unavailable_no_retry",
  "evidence_changed_during_run",
  "budget_guard_refused",
  "receipt_unavailable",
]);
const FOUNDATION_STATUSES = new Set([
  "answered",
  "partial",
  "insufficient_evidence",
  "invalid_question",
  "unavailable",
  "needs_clarification",
]);

function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function failStop(report, reason) {
  report.status = "stopped";
  report.stopReason = STOP_REASONS.has(reason)
    ? reason
    : "server_or_protocol_unavailable";
}

function writeDiagnostic() {
  process.stderr.write(
    "foundations-live-eval: stopped; credentials and raw errors omitted\n"
  );
}

async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("request failed");
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function isZeroPrice(value) {
  if (typeof value === "number") return Number.isFinite(value) && value === 0;
  return typeof value === "string" && /^\+?0+(?:\.0+)?$/.test(value.trim());
}

function qualifyZeroPricing(payload, model) {
  payload = asObject(payload);
  if (!payload || !Array.isArray(payload.data))
    throw new Error("catalog unavailable");
  const matches = payload.data.filter((entry) => asObject(entry)?.id === model);
  if (matches.length !== 1) throw new Error("model missing or ambiguous");
  const pricing = asObject(asObject(matches[0])?.pricing);
  const tokenFields = ["prompt", "completion"];
  if (
    !pricing ||
    tokenFields.some(
      (field) =>
        !Object.prototype.hasOwnProperty.call(pricing, field) ||
        !isZeroPrice(pricing[field])
    ) ||
    (Object.prototype.hasOwnProperty.call(pricing, "request") &&
      !isZeroPrice(pricing.request))
  ) {
    throw new Error("model is not verified zero-price");
  }
  return {
    prompt: "0",
    completion: "0",
    ...(Object.prototype.hasOwnProperty.call(pricing, "request")
      ? { request: "0" }
      : {}),
  };
}

async function verifyZeroPricing(model) {
  return qualifyZeroPricing(await fetchJson(CATALOG_URL), model);
}

async function readUsage(apiKey) {
  const payload = asObject(
    await fetchJson(KEY_USAGE_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
  );
  const data = asObject(payload?.data);
  const usage = data?.usage;
  const validString =
    typeof usage === "string" &&
    /^\+?(?:\d+(?:\.\d*)?|\.\d+)$/.test(usage.trim());
  const value =
    typeof usage === "number" ? usage : validString ? Number(usage) : NaN;
  if (
    (typeof usage !== "number" && typeof usage !== "string") ||
    (typeof usage === "string" && usage.trim() === "") ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new Error("usage measurement unavailable");
  }
  return value;
}

function fixtureFileForArgs(args) {
  const suites = new Map([
    ["--suite=foundations", "foundations-eval.json"],
    ["--suite=transfer", "expert-transfer-eval.json"],
    ["--suite=account-repair", "foundations-account-repair-eval.json"],
    ["--suite=acceptance", "expert-acceptance-eval.json"],
    ["--suite=expert-transfer", "expert-transfer-eval.json"],
    ["--suite=final-holdout", "expert-final-holdout-eval.json"],
    ["--suite=repair-delta", "expert-repair-delta-eval.json"],
    ["--suite=repair3-delta", "expert-repair3-delta-eval.json"],
    ["--suite=review-v2", "expert-review-v2-eval.json"],
    ["--suite=review-v2-delta", "expert-review-v2-delta-eval.json"],
  ]);
  if (args.length === 0) return "foundations-eval.json";
  if (args.length !== 1 || !suites.has(args[0]))
    throw new Error("unknown public suite");
  return suites.get(args[0]);
}

function readFixture(repoRoot, fixtureName) {
  const fixturePath = path.join(
    repoRoot,
    "mcp",
    "test",
    "fixtures",
    fixtureName
  );
  const fixture = asObject(JSON.parse(fs.readFileSync(fixturePath, "utf8")));
  if (!fixture || !Array.isArray(fixture.cases) || fixture.cases.length === 0)
    throw new Error("public fixture unavailable");
  for (const item of fixture.cases) {
    if (
      !asObject(item) ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      typeof item.question !== "string" ||
      !item.question.trim() ||
      typeof item.expectedStatus !== "string" ||
      !FOUNDATION_STATUSES.has(item.expectedStatus) ||
      !Array.isArray(item.requiredSourceIds) ||
      item.requiredSourceIds.some((id) => typeof id !== "string") ||
      (item.requiredSourceAlternatives !== undefined &&
        (!Array.isArray(item.requiredSourceAlternatives) ||
          item.requiredSourceAlternatives.length === 0 ||
          item.requiredSourceAlternatives.some(
            (proof) =>
              !Array.isArray(proof) ||
              proof.length === 0 ||
              proof.some((id) => typeof id !== "string" || !id.trim())
          )))
    ) {
      throw new Error("public fixture invalid");
    }
  }
  return fixture.cases;
}

function getResultPayload(result) {
  if (result?.isError) return undefined;
  const structured = asObject(result?.structuredContent);
  if (structured) return structured;
  const textContent = Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === "text")?.text
    : undefined;
  if (typeof textContent !== "string") return undefined;
  try {
    return asObject(JSON.parse(textContent));
  } catch {
    return undefined;
  }
}

function sourceIdsFromAnswer(answer) {
  if (!Array.isArray(answer?.sources)) return [];
  return answer.sources
    .map((source) => asObject(source)?.id)
    .filter((id) => typeof id === "string");
}

function retrievalMatches(requiredIds, retrievedIds, alternatives) {
  if (requiredIds.length === 0 && alternatives === undefined) return null;
  return (
    requiredIds.every((id) => retrievedIds.includes(id)) &&
    (alternatives === undefined ||
      alternatives.some(
        (proof) =>
          proof.length > 0 && proof.every((id) => retrievedIds.includes(id))
      ))
  );
}

function statusSummary(cases) {
  const statusMatchCount = cases.filter((item) => item.statusMatched).length;
  return {
    statusMatchCount,
    statusCheckPassed: statusMatchCount === cases.length,
  };
}

function isIsolatedProviderRefusal(status, diagnostics) {
  return (
    status === "unavailable" &&
    diagnostics.length > 0 &&
    diagnostics.every(({ code }) => code === "provider_refusal")
  );
}

// Calls are sequential and the runtime emits one diagnosed failure per call.
// A missing diagnostic must stop the suite; no later case may consume it.
function waitForCaseDiagnostics(
  reader,
  diagnostics,
  startIndex,
  timeoutMs = PROVIDER_DIAGNOSTIC_TIMEOUT_MS
) {
  const current = () => diagnostics.slice(startIndex);
  if (current().length || !reader || reader.closed)
    return Promise.resolve(current());
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      reader.removeListener("line", onLine);
      reader.removeListener("close", finish);
      resolve(current());
    };
    const onLine = (line) => {
      if (parseProviderDiagnostic(line)) finish();
    };
    // The report collector is registered first, so its allowlisted diagnostic
    // is present before this listener observes the same line.
    reader.on("line", onLine);
    reader.once("close", finish);
    timer = setTimeout(finish, timeoutMs);
  });
}

async function main() {
  const repoRoot = path.resolve(__dirname, "../..");
  const report = {
    status: "refused",
    profile: "foundations",
    transport: "MCP SDK client over stdio to built server",
    startedAt: new Date().toISOString(),
    model: null,
    verifiedPricing: null,
    cases: [],
    statusMatchCount: 0,
    statusCheckPassed: null,
    semanticReview: "not_performed",
    usageDelta: null,
    usageDeltaAttribution: "shared account counter; not per-request cost",
    providerDiagnostics: [],
    budgetDiagnostics: [],
    evidenceBinding: null,
    evidenceStable: null,
    spendingMode: "verified_zero_price",
    budget: null,
    complete: false,
    activeCase: null,
  };
  let apiKey;
  let usageBefore;
  let usageAfter;
  let usageAfterAttempted = false;
  let exitCode = 2;
  let budgetPlan;
  let budgetHelpers;
  let checkpoint;
  let receiptFailed = false;
  const budgetPlanPath = process.env.HEDWIG_EVAL_BUDGET_PLAN;
  const budgetLedgerPath = process.env.HEDWIG_EVAL_BUDGET_LEDGER;
  const reportPath = process.env.HEDWIG_EVAL_REPORT_PATH;
  const saveCheckpoint = () => {
    try {
      checkpoint?.(report);
    } catch {
      receiptFailed = true;
      throw new Error("receipt unavailable");
    }
  };

  try {
    apiKey = process.env.OPENROUTER_API_KEY?.trim();
    const model = process.env.HEDWIG_OPENROUTER_MODEL?.trim();
    const paidRequested = Boolean(budgetPlanPath || budgetLedgerPath);
    try {
      if (paidRequested || reportPath)
        checkpoint = createReportWriter(reportPath, repoRoot, report);
    } catch {
      failStop(report, "receipt_unavailable");
      writeDiagnostic();
      return exitCode;
    }
    if (!apiKey || !model || (!model.endsWith(":free") && !paidRequested)) {
      failStop(report, "configuration_missing_or_invalid");
      writeDiagnostic();
      return exitCode;
    }
    report.model = model;

    let fixtureCases;
    try {
      const fixtureName = fixtureFileForArgs(process.argv.slice(2));
      fixtureCases = readFixture(repoRoot, fixtureName);
      report.fixture = fixtureName;
    } catch {
      failStop(report, "fixture_invalid");
      writeDiagnostic();
      return exitCode;
    }

    const serverPath = path.join(repoRoot, "mcp", "dist", "server.js");
    const retrieverPath = path.join(repoRoot, "mcp", "dist", "knowledge.js");
    if (!fs.existsSync(serverPath) || !fs.existsSync(retrieverPath)) {
      failStop(report, "build_missing");
      writeDiagnostic();
      return exitCode;
    }
    report.evidenceBinding = captureEvidenceBinding(repoRoot, report.fixture);

    try {
      if (paidRequested) {
        if (
          !budgetPlanPath ||
          !budgetLedgerPath ||
          !path.isAbsolute(budgetPlanPath) ||
          !path.isAbsolute(budgetLedgerPath)
        ) {
          throw new Error("absolute budget paths required");
        }
        budgetHelpers = require("./live-eval-budget");
        const savedPlan = JSON.parse(fs.readFileSync(budgetPlanPath, "utf8"));
        budgetPlan = budgetHelpers.qualifyExistingBudgetPlan(
          budgetLedgerPath,
          savedPlan,
          await fetchJson(CATALOG_URL),
          model
        );
        // Creation is an explicit operator setup action. A missing ledger
        // cannot be interpreted as an unused spending allowance on resume.
        report.budget = budgetHelpers.readBudgetSummary(
          budgetLedgerPath,
          budgetPlan
        );
        if (report.budget.blocked) throw new Error("budget is blocked");
        report.spendingMode = "bounded_paid";
        report.budgetPlanHash = budgetPlan.planHash;
        report.verifiedPricing = budgetPlan.catalogPricing;
      } else {
        report.verifiedPricing = await verifyZeroPricing(model);
      }
    } catch {
      failStop(report, "price_qualification_failed");
      writeDiagnostic();
      return exitCode;
    }

    try {
      usageBefore = await readUsage(apiKey);
    } catch {
      failStop(report, "usage_measurement_unavailable");
      writeDiagnostic();
      return exitCode;
    }

    const requireFromMcp = createRequire(
      path.join(repoRoot, "mcp", "package.json")
    );
    const { Client } = requireFromMcp(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const { StdioClientTransport, getDefaultEnvironment } = requireFromMcp(
      "@modelcontextprotocol/sdk/client/stdio.js"
    );
    const { retrieveFoundationSources } = require(retrieverPath);
    const { prepareExpertRequest } = require(path.join(
      repoRoot,
      "mcp/dist/expert-workflow.js"
    ));

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: budgetPlan
        ? ["--require", path.join(__dirname, "live-eval-budget.js"), serverPath]
        : [serverPath],
      cwd: repoRoot,
      env: {
        ...getDefaultEnvironment(),
        HEDWIG_MODE: "education",
        HEDWIG_KNOWLEDGE_MODE: "foundations",
        HEDWIG_OPENROUTER_MODEL: model,
        OPENROUTER_API_KEY: apiKey,
        ...(budgetPlan
          ? {
              HEDWIG_EVAL_BUDGET_PLAN: budgetPlanPath,
              HEDWIG_EVAL_BUDGET_LEDGER: budgetLedgerPath,
              HEDWIG_EVAL_BUDGET_PRELOAD: "1",
            }
          : {}),
      },
      stderr: "pipe",
    });
    // Only fixed provider and budget diagnostic codes are retained separately. Raw stderr
    // can contain other application output and must never enter the report.
    const diagnosticReader = transport.stderr
      ? createInterface({ input: transport.stderr })
      : undefined;
    diagnosticReader?.on("line", (line) => {
      const diagnostic = parseProviderDiagnostic(line);
      if (
        diagnostic &&
        report.providerDiagnostics.length < fixtureCases.length
      ) {
        report.providerDiagnostics.push({
          ...diagnostic,
          observedAt: new Date().toISOString(),
        });
      }
      const budgetDiagnostic = parseBudgetDiagnostic(line);
      if (
        budgetDiagnostic &&
        report.budgetDiagnostics.length < fixtureCases.length * 2
      ) {
        report.budgetDiagnostics.push({
          ...budgetDiagnostic,
          observedAt: new Date().toISOString(),
        });
      }
    });
    const client = new Client(
      { name: "hedwig-foundations-public-eval", version: "0.1.0" },
      { capabilities: {} }
    );

    let stopAfterUnavailable = false;
    try {
      await client.connect(transport);
      let callsStarted = 0;
      for (const item of fixtureCases) {
        if (callsStarted > 0) {
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              budgetPlan ? PAID_BETWEEN_CASES_MS : BETWEEN_CASES_MS
            )
          );
        }
        callsStarted += 1;
        const prepared = prepareExpertRequest(
          { question: item.question, ...(item.arguments ?? {}) },
          retrieveFoundationSources
        );
        const retrievedIds =
          prepared.status === "ready"
            ? prepared.sources.map((source) => source.id)
            : [];
        const started = Date.now();
        if (budgetPlan)
          report.budget = budgetHelpers.readBudgetSummary(
            budgetLedgerPath,
            budgetPlan
          );
        const providerRequestsBefore = budgetPlan
          ? report.budget.requestCount
          : undefined;
        report.status = "running";
        report.activeCase = {
          testcaseId: item.id,
          startedAt: new Date().toISOString(),
          ...(providerRequestsBefore !== undefined
            ? { providerRequestsBefore }
            : {}),
        };
        saveCheckpoint();
        const diagnosticStart = report.providerDiagnostics.length;
        const budgetDiagnosticStart = report.budgetDiagnostics.length;
        let callResult;
        try {
          callResult = await client.callTool({
            name: "ask_hedwig",
            arguments: { question: item.question, ...(item.arguments ?? {}) },
          });
        } catch {
          // Preserve the ledger delta below even when the MCP response fails.
        }

        const answer = getResultPayload(callResult);
        if (budgetPlan)
          report.budget = budgetHelpers.readBudgetSummary(
            budgetLedgerPath,
            budgetPlan
          );
        const providerRequestsStarted = budgetPlan
          ? report.budget.requestCount - providerRequestsBefore
          : undefined;
        if (!answer) {
          await waitForCaseDiagnostics(
            diagnosticReader,
            report.providerDiagnostics,
            diagnosticStart
          );
          report.cases.push({
            testcaseId: item.id,
            expectedStatus: item.expectedStatus,
            result: { status: "unavailable" },
            ...(providerRequestsStarted !== undefined
              ? { providerRequestsBefore, providerRequestsStarted }
              : {}),
            latencyMs: Date.now() - started,
            retrievedIds,
            requiredRetrievalMatched: retrievalMatches(
              item.requiredSourceIds,
              retrievedIds,
              item.requiredSourceAlternatives
            ),
            statusMatched: false,
          });
          failStop(
            report,
            report.budgetDiagnostics.length > budgetDiagnosticStart ||
              report.budget?.blocked
              ? "budget_guard_refused"
              : "server_or_protocol_unavailable"
          );
          report.activeCase = null;
          saveCheckpoint();
          stopAfterUnavailable = true;
          break;
        }

        const status =
          typeof answer.status === "string" &&
          FOUNDATION_STATUSES.has(answer.status)
            ? answer.status
            : "invalid_result";
        const latencyMs = Date.now() - started;
        const caseDiagnostics =
          status === "unavailable"
            ? await waitForCaseDiagnostics(
                diagnosticReader,
                report.providerDiagnostics,
                diagnosticStart
              )
            : report.providerDiagnostics.slice(diagnosticStart);
        const budgetRefused =
          report.budgetDiagnostics.length > budgetDiagnosticStart ||
          Boolean(report.budget?.blocked);
        const providerRefusal =
          !budgetRefused && isIsolatedProviderRefusal(status, caseDiagnostics);
        const result = {
          status,
          ...(typeof answer.answer === "string"
            ? { answer: answer.answer }
            : {}),
          sourceIds: sourceIdsFromAnswer(answer),
          ...(Array.isArray(answer.availableSources)
            ? {
                availableSourceIds: answer.availableSources
                  .map((s) => s?.id)
                  .filter((id) => typeof id === "string"),
              }
            : {}),
          unsupportedParts: Array.isArray(answer.unsupportedParts)
            ? answer.unsupportedParts.filter((part) => typeof part === "string")
            : [],
          ...(asObject(answer.comparison)
            ? { comparison: answer.comparison }
            : {}),
          ...(Array.isArray(answer.supportedDeployments)
            ? { supportedDeployments: answer.supportedDeployments }
            : {}),
        };
        report.cases.push({
          testcaseId: item.id,
          expectedStatus: item.expectedStatus,
          result,
          ...(providerRequestsStarted !== undefined
            ? { providerRequestsBefore, providerRequestsStarted }
            : {}),
          latencyMs,
          retrievedIds,
          requiredRetrievalMatched: retrievalMatches(
            item.requiredSourceIds,
            retrievedIds,
            item.requiredSourceAlternatives
          ),
          statusMatched: status === item.expectedStatus,
          providerRefusal,
        });
        report.activeCase = null;
        saveCheckpoint();
        process.stderr.write(
          `foundations-live-eval: case=${item.id} status=${status}\n`
        );

        if (
          budgetRefused ||
          (status === "unavailable" && !providerRefusal) ||
          status === "invalid_result"
        ) {
          failStop(
            report,
            budgetRefused
              ? "budget_guard_refused"
              : status === "unavailable"
              ? "model_unavailable_no_retry"
              : "server_or_protocol_unavailable"
          );
          stopAfterUnavailable = true;
          break;
        }
      }
    } catch {
      failStop(
        report,
        receiptFailed ? "receipt_unavailable" : "server_or_protocol_unavailable"
      );
      stopAfterUnavailable = true;
    } finally {
      await client.close().catch(() => undefined);
      diagnosticReader?.close();
    }

    usageAfterAttempted = true;
    try {
      usageAfter = await readUsage(apiKey);
      report.usageDelta = usageAfter - usageBefore;
    } catch {
      report.usageDelta = null;
      failStop(report, "usage_measurement_unavailable");
      stopAfterUnavailable = true;
    }

    if (!stopAfterUnavailable) {
      Object.assign(report, statusSummary(report.cases));
      report.status = "completed";
      report.complete = report.cases.length === fixtureCases.length;
      exitCode = report.complete ? (report.statusCheckPassed ? 0 : 1) : 2;
    } else {
      report.complete = false;
      writeDiagnostic();
    }
  } catch {
    failStop(
      report,
      receiptFailed ? "receipt_unavailable" : "server_or_protocol_unavailable"
    );
    writeDiagnostic();
  } finally {
    if (budgetPlan && budgetHelpers) {
      try {
        report.budget = budgetHelpers.readBudgetSummary(
          budgetLedgerPath,
          budgetPlan
        );
        if (report.budget.blocked) {
          failStop(report, "budget_guard_refused");
          report.complete = false;
          exitCode = 2;
        }
      } catch {
        failStop(report, "budget_guard_refused");
        report.complete = false;
        exitCode = 2;
      }
    }
    if (report.evidenceBinding) {
      try {
        report.evidenceStable = evidenceBindingsMatch(
          report.evidenceBinding,
          captureEvidenceBinding(repoRoot, report.fixture)
        );
      } catch {
        report.evidenceStable = false;
      }
      if (!report.evidenceStable) {
        failStop(report, "evidence_changed_during_run");
        report.complete = false;
        exitCode = 2;
      }
    }
    if (usageBefore !== undefined && !usageAfterAttempted) {
      usageAfterAttempted = true;
      try {
        usageAfter = await readUsage(apiKey);
        report.usageDelta = usageAfter - usageBefore;
      } catch {
        report.usageDelta = null;
        failStop(report, "usage_measurement_unavailable");
        report.complete = false;
        exitCode = 2;
        writeDiagnostic();
      }
    }
    report.statusMatchCount = statusSummary(report.cases).statusMatchCount;
    report.providerRefusalCount = report.cases.filter(
      (item) => item.providerRefusal
    ).length;
    report.finishedAt = new Date().toISOString();
    apiKey = undefined;
    try {
      saveCheckpoint();
    } catch {
      failStop(report, "receipt_unavailable");
      report.complete = false;
      exitCode = 2;
      writeDiagnostic();
    } finally {
      checkpoint?.close();
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = exitCode;
  }
}

module.exports = {
  fixtureFileForArgs,
  qualifyZeroPricing,
  retrievalMatches,
  statusSummary,
  isIsolatedProviderRefusal,
  waitForCaseDiagnostics,
};

if (require.main === module) {
  main().catch(() => {
    writeDiagnostic();
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "stopped",
          stopReason: "server_or_protocol_unavailable",
          usageDelta: null,
          cases: [],
          statusMatchCount: 0,
          statusCheckPassed: null,
          semanticReview: "not_performed",
          complete: false,
        },
        null,
        2
      )}\n`
    );
    process.exitCode = 2;
  });
}
