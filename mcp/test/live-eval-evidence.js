"use strict";

const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const EVIDENCE_FILES = Object.freeze([
  "mcp/dist/server.js",
  "mcp/dist/server-core.js",
  "mcp/dist/expert.js",
  "mcp/dist/expert-request.js",
  "mcp/dist/expert-workflow.js",
  "mcp/dist/foundation-answer.js",
  "mcp/dist/foundation-content.js",
  "mcp/src/foundation-pack-integrity.ts",
  "mcp/dist/foundation-pack-integrity.js",
  "mcp/dist/comparison-answer.js",
  "mcp/dist/knowledge.js",
  "mcp/dist/knowledge/foundations.json",
  "mcp/dist/openrouter.js",
  "mcp/dist/model-policy.js",
  "mcp/test/foundations-live-eval.js",
  "mcp/test/live-eval-evidence.js",
  "mcp/test/live-eval-budget.js",
  "mcp/test/live-eval-report.js",
]);

const DIAGNOSTIC_CODES = new Set([
  "rate_limited",
  "authentication_failed",
  "http_error",
  "deadline_exceeded",
  "cancelled",
  "request_too_large",
  "response_too_large",
  "invalid_response",
  "completion_truncated",
  "provider_refusal",
  "transport_error",
]);

const BUDGET_DIAGNOSTIC_CODES = new Set([
  "cap_exhausted",
  "cost_unverified",
  "generation_id_conflict",
  "initialization_failed",
  "invalid_configuration",
  "invalid_ledger",
  "invalid_ledger_path",
  "invalid_plan",
  "invalid_reconciliation_evidence",
  "invalid_reconciliation_record",
  "ledger_busy",
  "ledger_failure",
  "ledger_inside_repository",
  "lock_identity_changed",
  "request_rejected",
  "request_too_large",
  "request_uncertain",
  "unsettled_request",
]);

function parseBudgetDiagnostic(line) {
  const match = /^hedwig-budget: code=([a-z_]+)\r?$/.exec(line);
  return match && BUDGET_DIAGNOSTIC_CODES.has(match[1])
    ? { code: match[1] }
    : undefined;
}

function parseProviderDiagnostic(line) {
  const match =
    /^hedwig-model: code=([a-z_]+)(?: httpStatus=([45][0-9]{2}))?\r?$/.exec(
      line
    );
  return match && DIAGNOSTIC_CODES.has(match[1])
    ? { code: match[1], ...(match[2] ? { httpStatus: Number(match[2]) } : {}) }
    : undefined;
}

function captureEvidenceBinding(repoRoot, fixtureName) {
  if (!/^[a-z0-9-]+\.json$/.test(fixtureName)) {
    throw new Error("invalid public fixture name");
  }
  const files = {};
  for (const relative of [
    ...EVIDENCE_FILES,
    "mcp/test/fixtures/" + fixtureName,
  ]) {
    files[relative] = createHash("sha256")
      .update(readFileSync(path.join(repoRoot, relative)))
      .digest("hex");
  }
  return { algorithm: "sha256", files };
}

function evidenceBindingsMatch(before, after) {
  return (
    before.algorithm === after.algorithm &&
    Object.keys(before.files).length === Object.keys(after.files).length &&
    Object.entries(before.files).every(
      ([file, hash]) => after.files[file] === hash
    )
  );
}

module.exports = {
  EVIDENCE_FILES,
  parseProviderDiagnostic,
  parseBudgetDiagnostic,
  captureEvidenceBinding,
  evidenceBindingsMatch,
};
