#!/usr/bin/env node
"use strict";

const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const KEY_USAGE_URL = "https://openrouter.ai/api/v1/key";
const LIVE_REQUEST_TIMEOUT_MS = 10_000;
const STOP_REASONS = new Set([
  "configuration_missing_or_invalid",
  "fixture_invalid",
  "build_missing",
  "price_qualification_failed",
  "usage_measurement_unavailable",
  "server_or_protocol_unavailable",
  "model_unavailable_no_retry",
]);
const FOUNDATION_STATUSES = new Set([
  "answered",
  "partial",
  "insufficient_evidence",
  "invalid_question",
  "unavailable",
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

async function verifyZeroPricing(model) {
  const payload = asObject(await fetchJson(CATALOG_URL));
  if (!payload || !Array.isArray(payload.data))
    throw new Error("catalog unavailable");
  const matches = payload.data.filter((entry) => asObject(entry)?.id === model);
  if (matches.length !== 1) throw new Error("model missing or ambiguous");
  const pricing = asObject(asObject(matches[0])?.pricing);
  const fields = ["prompt", "completion", "request"];
  if (
    !pricing ||
    fields.some(
      (field) =>
        !Object.prototype.hasOwnProperty.call(pricing, field) ||
        !isZeroPrice(pricing[field])
    )
  ) {
    throw new Error("model is not verified zero-price");
  }
  return { prompt: "0", completion: "0", request: "0" };
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

function readFixture(repoRoot) {
  const fixturePath = path.join(
    repoRoot,
    "mcp",
    "test",
    "fixtures",
    "foundations-eval.json"
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
      item.requiredSourceIds.some((id) => typeof id !== "string")
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

function retrievalMatches(requiredIds, retrievedIds) {
  if (requiredIds.length === 0) return null;
  return requiredIds.every((id) => retrievedIds.includes(id));
}

function statusSummary(cases) {
  const statusMatchCount = cases.filter((item) => item.statusMatched).length;
  return {
    statusMatchCount,
    statusCheckPassed: statusMatchCount === cases.length,
  };
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
    complete: false,
  };
  let apiKey;
  let usageBefore;
  let usageAfter;
  let usageAfterAttempted = false;
  let exitCode = 2;

  try {
    apiKey = process.env.OPENROUTER_API_KEY?.trim();
    const model = process.env.HEDWIG_OPENROUTER_MODEL?.trim();
    if (!apiKey || !model || !model.endsWith(":free")) {
      failStop(report, "configuration_missing_or_invalid");
      writeDiagnostic();
      return exitCode;
    }
    report.model = model;

    let fixtureCases;
    try {
      fixtureCases = readFixture(repoRoot);
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

    try {
      report.verifiedPricing = await verifyZeroPricing(model);
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

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: repoRoot,
      env: {
        ...getDefaultEnvironment(),
        HEDWIG_MODE: "education",
        HEDWIG_KNOWLEDGE_MODE: "foundations",
        HEDWIG_OPENROUTER_MODEL: model,
        OPENROUTER_API_KEY: apiKey,
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    const client = new Client(
      { name: "hedwig-foundations-public-eval", version: "0.1.0" },
      { capabilities: {} }
    );

    let stopAfterUnavailable = false;
    try {
      await client.connect(transport);
      for (const item of fixtureCases) {
        const retrievedIds = retrieveFoundationSources(item.question).map(
          (source) => source.id
        );
        const started = Date.now();
        let callResult;
        try {
          callResult = await client.callTool({
            name: "ask_hedwig",
            arguments: { question: item.question },
          });
        } catch {
          report.cases.push({
            testcaseId: item.id,
            expectedStatus: item.expectedStatus,
            result: { status: "unavailable" },
            latencyMs: Date.now() - started,
            retrievedIds,
            requiredRetrievalMatched: retrievalMatches(
              item.requiredSourceIds,
              retrievedIds
            ),
            statusMatched: false,
          });
          failStop(report, "server_or_protocol_unavailable");
          stopAfterUnavailable = true;
          break;
        }

        const answer = getResultPayload(callResult);
        if (!answer) {
          report.cases.push({
            testcaseId: item.id,
            expectedStatus: item.expectedStatus,
            result: { status: "unavailable" },
            latencyMs: Date.now() - started,
            retrievedIds,
            requiredRetrievalMatched: retrievalMatches(
              item.requiredSourceIds,
              retrievedIds
            ),
            statusMatched: false,
          });
          failStop(report, "server_or_protocol_unavailable");
          stopAfterUnavailable = true;
          break;
        }

        const status =
          typeof answer.status === "string" &&
          FOUNDATION_STATUSES.has(answer.status)
            ? answer.status
            : "invalid_result";
        const result = {
          status,
          ...(typeof answer.answer === "string"
            ? { answer: answer.answer }
            : {}),
          sourceIds: sourceIdsFromAnswer(answer),
          unsupportedParts: Array.isArray(answer.unsupportedParts)
            ? answer.unsupportedParts.filter((part) => typeof part === "string")
            : [],
        };
        report.cases.push({
          testcaseId: item.id,
          expectedStatus: item.expectedStatus,
          result,
          latencyMs: Date.now() - started,
          retrievedIds,
          requiredRetrievalMatched: retrievalMatches(
            item.requiredSourceIds,
            retrievedIds
          ),
          statusMatched: status === item.expectedStatus,
        });

        if (status === "unavailable" || status === "invalid_result") {
          failStop(
            report,
            status === "unavailable"
              ? "model_unavailable_no_retry"
              : "server_or_protocol_unavailable"
          );
          stopAfterUnavailable = true;
          break;
        }
      }
    } catch {
      failStop(report, "server_or_protocol_unavailable");
      stopAfterUnavailable = true;
    } finally {
      await client.close().catch(() => undefined);
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
    failStop(report, "server_or_protocol_unavailable");
    writeDiagnostic();
  } finally {
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
    report.finishedAt = new Date().toISOString();
    apiKey = undefined;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = exitCode;
  }
}

module.exports = { retrievalMatches, statusSummary };

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
