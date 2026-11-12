"use strict";

// Evaluation-only spending boundary. Catalog token prices are USD/token;
// provider.max_price prompt/completion caps are USD/million tokens.
// https://openrouter.ai/docs/guides/routing/provider-selection
// usage.cost is the amount charged, not upstream_inference_cost.
// https://openrouter.ai/docs/cookbook/administration/usage-accounting
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const MODEL = "openai/gpt-4.1-mini";
const REASONING_PROFILES = new Map([
  [
    "openai/gpt-5.1",
    {
      maxTokens: 4096,
      deadlineMs: 20000,
      reasoning: { effort: "low", exclude: true },
    },
  ],
  [
    "openai/gpt-5.2",
    {
      maxTokens: 6144,
      deadlineMs: 30000,
      reasoning: { effort: "medium", exclude: true },
    },
  ],
]);
const ALLOWED_MODELS = new Set([
  MODEL,
  "openai/gpt-4.1",
  ...REASONING_PROFILES.keys(),
]);
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
// Explicitly reviewed public catalog identity, not a model-name heuristic.
// Retain this historical binding when adding a separately reviewed identity.
const RECONCILIATION_MODEL_IDENTITY = Object.freeze({
  requestedModel: "openai/gpt-5.2",
  canonicalModel: "openai/gpt-5.2-20251211",
  catalogRetrievedAt: "2026-11-12T16:30:23.655Z",
  catalogResponseSha256:
    "43199a7f1e2e3aaac2e82c1e4d928671454ee8e620d5e53a9e3e1d9dd0886e1d",
});
const NANO_USD = 1e9;
const MILLION = 1e6;
const CAP_USD = 5;
const REQUEST_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 64 * 1024;
const RESPONSE_DEADLINE_MS = 15000;
const REPO = path.resolve(__dirname, "../..");

function fail(code) {
  throw new Error(`hedwig-budget: code=${code}`);
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}
function hash(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function price(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))
    fail("invalid_catalog");
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > CAP_USD)
    fail("invalid_catalog");
  return amount;
}

function createBudgetPlan(catalog, model = MODEL, capUsd = CAP_USD) {
  if (
    !ALLOWED_MODELS.has(model) ||
    typeof capUsd !== "number" ||
    !Number.isFinite(capUsd) ||
    capUsd <= 0 ||
    capUsd > CAP_USD
  )
    fail("invalid_plan");
  const row = Array.isArray(catalog?.data)
    ? catalog.data.find((item) => item.id === model)
    : catalog;
  if (
    !object(row) ||
    row.id !== model ||
    !integer(row.context_length) ||
    !row.context_length ||
    !integer(row.top_provider?.max_completion_tokens) ||
    !row.top_provider.max_completion_tokens ||
    !object(row.pricing)
  )
    fail("invalid_catalog");
  const prompt = price(row.pricing.prompt);
  const completion = price(row.pricing.completion);
  if (!prompt || !completion) fail("invalid_catalog");
  for (const [key, value] of Object.entries(row.pricing)) {
    const amount = price(value);
    if (["prompt", "completion", "web_search"].includes(key)) continue;
    // Cached input can only discount the full input reservation. Web search is
    // separately priced but impossible under the strict text-only request shape.
    if (key === "input_cache_read" && amount <= prompt) continue;
    if (amount !== 0) fail("unsupported_billing");
  }
  const plan = {
    schemaVersion: 1,
    model,
    capNanoUsd: Math.floor(capUsd * NANO_USD),
    contextLength: row.context_length,
    maxCompletionTokens: row.top_provider.max_completion_tokens,
    catalogPricing: canonical(row.pricing),
    maxPrice: {
      prompt: Math.ceil(prompt * NANO_USD) / (NANO_USD / MILLION),
      completion: Math.ceil(completion * NANO_USD) / (NANO_USD / MILLION),
      request: 0,
      image: 0,
    },
  };
  if (!plan.capNanoUsd || !integer(plan.capNanoUsd)) fail("invalid_plan");
  return { ...plan, planHash: hash(plan) };
}

function validatePlan(plan) {
  if (!object(plan)) fail("invalid_plan");
  const extended = plan.schemaVersion === 2;
  if (
    extended &&
    (!integer(plan.capNanoUsd) ||
      !plan.capNanoUsd ||
      !digest(plan.previousPlanHash) ||
      !digest(plan.capAuthorizationHash))
  )
    fail("invalid_plan");
  let expected = createBudgetPlan(
    {
      id: plan.model,
      context_length: plan.contextLength,
      top_provider: { max_completion_tokens: plan.maxCompletionTokens },
      pricing: plan.catalogPricing,
    },
    plan.model,
    extended ? CAP_USD : plan.capNanoUsd / NANO_USD
  );
  // This checks shape/economics only. An extended plan acquires authority solely
  // through the existing ledger's validated predecessor/authorization chain.
  if (extended)
    expected = planWithHash({
      ...expected,
      schemaVersion: 2,
      capNanoUsd: plan.capNanoUsd,
      previousPlanHash: plan.previousPlanHash,
      capAuthorizationHash: plan.capAuthorizationHash,
    });
  if (hash(expected) !== hash(plan)) fail("invalid_plan");
  return expected;
}
function planWithHash(value) {
  const { planHash: _oldHash, ...content } = value;
  return { ...content, planHash: hash(content) };
}
function extendedPlan(previous, authorization) {
  return planWithHash({
    ...previous,
    schemaVersion: 2,
    capNanoUsd: authorization.approvedTotalNanoUsd,
    previousPlanHash: previous.planHash,
    capAuthorizationHash: hash(authorization),
  });
}
function reservation(plan, maxTokens) {
  // Round each unit upwards, then multiply: never underestimate a catalog price.
  const amount =
    plan.contextLength *
      Math.ceil(price(plan.catalogPricing.prompt) * NANO_USD) +
    maxTokens * Math.ceil(price(plan.catalogPricing.completion) * NANO_USD);
  if (!integer(amount)) fail("invalid_plan");
  return amount;
}
function ledgerLocation(filename) {
  if (typeof filename !== "string" || !path.isAbsolute(filename))
    fail("invalid_ledger_path");
  const resolved = path.join(
    fs.realpathSync(path.dirname(filename)),
    path.basename(filename)
  );
  const relative = path.relative(REPO, resolved);
  if (
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  )
    fail("ledger_inside_repository");
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink())
    fail("invalid_ledger_path");
  return resolved;
}
function syncParentDirectory(filename) {
  // Node cannot portably fsync directory handles on Windows. File fsync still
  // applies there, but directory persistence across power loss is not guaranteed.
  if (process.platform === "win32") return;
  const fd = fs.openSync(path.dirname(filename), "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function exclusiveLock(filename) {
  let fd;
  let fileIdentity;
  const identity = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  function ownsPath() {
    const current = fs.lstatSync(filename, { bigint: true });
    return (
      fileIdentity &&
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === fileIdentity.dev &&
      current.ino === fileIdentity.ino
    );
  }
  try {
    fd = fs.openSync(filename, "wx", 0o600);
    fileIdentity = fs.fstatSync(fd, { bigint: true });
    fs.writeFileSync(fd, identity);
    fs.fsyncSync(fd);
    syncParentDirectory(filename);
  } catch {
    if (fd !== undefined) {
      try {
        // A partial identity is not yet a recoverable owner record. Remove only
        // the inode we exclusively created, never a replacement at its path.
        if (ownsPath()) {
          fs.unlinkSync(filename);
          syncParentDirectory(filename);
        }
      } catch {
        /* Preserve an unremovable lock and fail closed. */
      } finally {
        fs.closeSync(fd);
      }
    }
    fail("ledger_busy");
  }
  return {
    identity,
    release({ preserveLock = false } = {}) {
      // A failed or interrupted cap commit is operator-recoverable evidence,
      // never permission for the next request to assume the commit succeeded.
      try {
        if (preserveLock) return;
        // Keep the descriptor open so its inode cannot be reused during cleanup.
        // A recovery or failed contender must never remove another owner's lock.
        if (!ownsPath() || fs.readFileSync(filename, "utf8") !== identity)
          fail("lock_identity_changed");
        fs.unlinkSync(filename);
        syncParentDirectory(filename);
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}
function lockLedger(filename, recoveryIdentity) {
  const gate = `${filename}.recovery.lock`;
  const checkGate = () => {
    if (recoveryIdentity !== undefined) {
      if (fs.readFileSync(gate, "utf8") !== recoveryIdentity)
        fail("ledger_busy");
    } else if (fs.existsSync(gate)) fail("ledger_busy");
  };
  checkGate();
  const lock = exclusiveLock(`${filename}.lock`);
  try {
    checkGate();
  } catch (error) {
    lock.release();
    throw error;
  }
  return (options) => lock.release(options);
}
function timestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function accountedCost(entry) {
  const amount =
    entry.status === "settled" ? entry.costNanoUsd : entry.reservedNanoUsd;
  if (!integer(amount)) fail("invalid_ledger");
  return amount;
}
function digest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function validRecovery(entry) {
  const recovery = entry.recovery;
  const keys = [
    "disposition",
    "recoveryId",
    "entryId",
    "previousStatus",
    "previousLedgerIntegrity",
    "lockSha256",
    "ownerPid",
    "reservedNanoUsd",
    "recoveredAt",
  ];
  return (
    object(recovery) &&
    Object.keys(recovery).length === keys.length &&
    keys.every((key) => Object.hasOwn(recovery, key)) &&
    recovery.disposition === "full_reservation_accounted" &&
    typeof recovery.recoveryId === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      recovery.recoveryId
    ) &&
    recovery.entryId === entry.id &&
    ["reserved", "uncertain"].includes(recovery.previousStatus) &&
    digest(recovery.previousLedgerIntegrity) &&
    digest(recovery.lockSha256) &&
    integer(recovery.ownerPid) &&
    recovery.ownerPid > 0 &&
    recovery.reservedNanoUsd === entry.reservedNanoUsd &&
    timestamp(recovery.recoveredAt)
  );
}
function readLedger(filename, plan) {
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    fail("invalid_ledger");
  }
  if (!object(ledger)) fail("invalid_ledger");
  const { integrity, ...content } = ledger;
  if (
    integrity !== hash(content) ||
    ![1, 2, 3].includes(ledger.schemaVersion) ||
    ledger.planHash !== plan.planHash ||
    ledger.capNanoUsd !== plan.capNanoUsd ||
    !Array.isArray(ledger.entries)
  )
    fail("invalid_ledger");
  const plans = new Map([[plan.planHash, plan]]);
  if (ledger.schemaVersion >= 2) {
    if (!Array.isArray(ledger.planHistory) || !ledger.planHistory.length)
      fail("invalid_ledger");
    plans.clear();
    for (const historical of ledger.planHistory) {
      const validated = validatePlan(historical);
      if (
        (ledger.schemaVersion === 2 &&
          (validated.schemaVersion !== 1 ||
            validated.capNanoUsd !== ledger.capNanoUsd)) ||
        plans.has(validated.planHash)
      )
        fail("invalid_ledger");
      plans.set(validated.planHash, validated);
    }
    if (
      ledger.planHistory[ledger.planHistory.length - 1].planHash !==
      plan.planHash
    )
      fail("invalid_ledger");
  } else if (ledger.planHistory !== undefined || plan.schemaVersion !== 1) {
    fail("invalid_ledger");
  }
  if (ledger.schemaVersion === 3) validateCapHistory(content);
  else if (ledger.capAuthorizations !== undefined) fail("invalid_ledger");
  const ids = new Set();
  let accounted = 0;
  for (const [entryIndex, entry] of ledger.entries.entries()) {
    const entryPlan =
      ledger.schemaVersion >= 2 ? plans.get(entry?.planHash) : plan;
    if (
      !object(entry) ||
      !entryPlan ||
      (ledger.schemaVersion === 1 && entry.planHash !== undefined) ||
      typeof entry.id !== "string" ||
      ids.has(entry.id) ||
      !integer(entry.maxTokens) ||
      !entry.maxTokens ||
      entry.maxTokens > entryPlan.maxCompletionTokens ||
      entry.reservedNanoUsd !== reservation(entryPlan, entry.maxTokens) ||
      !["reserved", "settled", "uncertain"].includes(entry.status)
    )
      fail("invalid_ledger");
    ids.add(entry.id);
    if (entry.status === "settled") {
      if (
        !integer(entry.costNanoUsd) ||
        entry.costNanoUsd > entry.reservedNanoUsd
      )
        fail("invalid_ledger");
    } else {
      if (entry.costNanoUsd !== undefined) fail("invalid_ledger");
    }
    if (
      entry.recovery !== undefined &&
      (entry.status !== "uncertain" || !validRecovery(entry))
    )
      fail("invalid_ledger");
    for (const key of [
      "requestedAt",
      "responseReceivedAt",
      "completedAt",
      "providerCreatedAt",
    ])
      if (entry[key] !== undefined && !timestamp(entry[key]))
        fail("invalid_ledger");
    if (
      entry.generationId !== undefined &&
      !validGenerationId(entry.generationId)
    )
      fail("invalid_ledger");
    if (
      entry.receiptIssue !== undefined &&
      (entry.receiptIssue !== "generation_id_conflict" ||
        entry.status !== "uncertain" ||
        !validGenerationId(entry.generationId))
    )
      fail("invalid_ledger");
    if (entry.reconciliation !== undefined)
      validateReconciliationRecord(content, entryIndex, entryPlan);
    accounted += accountedCost(entry);
  }
  if (!integer(accounted) || accounted > plan.capNanoUsd)
    fail("invalid_ledger");
  return content;
}
function writeLedger(filename, content, createOnly = false) {
  const serialized =
    JSON.stringify({ ...content, integrity: hash(content) }, null, 2) + "\n";
  const target = createOnly ? filename : `${filename}.${randomUUID()}.tmp`;
  const fd = fs.openSync(target, "wx", 0o600);
  try {
    fs.writeFileSync(fd, serialized);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!createOnly) fs.renameSync(target, filename);
  syncParentDirectory(filename);
}
function summary(ledger) {
  let spent = 0;
  let reserved = 0;
  let recoveredReserved = 0;
  let blocked = false;
  for (const entry of ledger.entries) {
    const amount = accountedCost(entry);
    if (entry.status === "settled") spent += amount;
    else {
      reserved += amount;
      if (entry.recovery) recoveredReserved += amount;
      else blocked = true;
    }
  }
  return {
    spentUsd: spent / NANO_USD,
    reservedUsd: reserved / NANO_USD,
    recoveredReservedUsd: recoveredReserved / NANO_USD,
    remainingUsd: (ledger.capNanoUsd - spent - reserved) / NANO_USD,
    blocked,
    requestCount: ledger.entries.length,
  };
}
function initializeBudgetLedger(filename, suppliedPlan) {
  const plan = validatePlan(suppliedPlan);
  if (plan.schemaVersion !== 1) fail("extended_plan_requires_existing_ledger");
  const location = ledgerLocation(filename);
  const unlock = lockLedger(location);
  try {
    if (!fs.existsSync(location))
      writeLedger(
        location,
        {
          schemaVersion: 2,
          planHash: plan.planHash,
          planHistory: [plan],
          capNanoUsd: plan.capNanoUsd,
          entries: [],
        },
        true
      );
    return summary(readLedger(location, plan));
  } finally {
    unlock();
  }
}
function readBudgetSummary(filename, suppliedPlan) {
  const plan = validatePlan(suppliedPlan);
  return summary(readLedger(ledgerLocation(filename), plan));
}

/** Read-only catalog requalification, never creation of another allowance. */
function qualifyExistingBudgetPlan(
  filename,
  suppliedPlan,
  catalog,
  model = suppliedPlan?.model
) {
  const plan = validatePlan(suppliedPlan);
  readLedger(ledgerLocation(filename), plan);
  let fresh = createBudgetPlan(
    catalog,
    model,
    plan.schemaVersion === 2 ? CAP_USD : plan.capNanoUsd / NANO_USD
  );
  if (plan.schemaVersion === 2)
    fresh = planWithHash({
      ...fresh,
      schemaVersion: 2,
      capNanoUsd: plan.capNanoUsd,
      previousPlanHash: plan.previousPlanHash,
      capAuthorizationHash: plan.capAuthorizationHash,
    });
  if (hash(fresh) !== hash(plan)) fail("catalog_plan_changed");
  return fresh;
}

function rawHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function lockOwner(bytes) {
  const text = bytes.toString("utf8").trim();
  let owner;
  try {
    owner = text.startsWith("{") ? JSON.parse(text).pid : Number(text);
  } catch {
    fail("invalid_lock");
  }
  if (!integer(owner) || !owner) fail("invalid_lock");
  return owner;
}
function requireDeadOwner(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return;
  }
  fail("owner_not_confirmed_dead");
}
function durableExclusiveWrite(filename, bytes) {
  const fd = fs.openSync(filename, "wx", 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncParentDirectory(filename);
}

/** Operator-only quarantine: actual cost remains unknown and its full reservation is never released. */
function recoverInterruptedReservation(filename, suppliedPlan, expected) {
  const plan = validatePlan(suppliedPlan);
  const location = ledgerLocation(filename);
  if (
    !object(expected) ||
    !digest(expected.expectedLedgerIntegrity) ||
    !digest(expected.expectedLockSha256) ||
    typeof expected.expectedEntryId !== "string" ||
    !expected.expectedEntryId ||
    !integer(expected.expectedOwnerPid) ||
    !expected.expectedOwnerPid
  )
    fail("invalid_recovery_request");
  const gate = exclusiveLock(`${location}.recovery.lock`);
  let unlock;
  let retiredLock;
  let recoveryRecorded = false;
  try {
    const before = fs.readFileSync(location);
    const lockPath = `${location}.lock`;
    const lockStat = fs.lstatSync(lockPath);
    if (!lockStat.isFile() || lockStat.isSymbolicLink()) fail("invalid_lock");
    const beforeLock = fs.readFileSync(lockPath);
    const ledger = readLedger(location, plan);
    const entry = ledger.entries.find(
      (item) => item.id === expected.expectedEntryId
    );
    if (
      hash(ledger) !== expected.expectedLedgerIntegrity ||
      rawHash(beforeLock) !== expected.expectedLockSha256 ||
      lockOwner(beforeLock) !== expected.expectedOwnerPid ||
      !entry ||
      !["reserved", "uncertain"].includes(entry.status) ||
      ledger.entries.some(
        (item) => item !== entry && item.status !== "settled" && !item.recovery
      )
    )
      fail("recovery_state_changed");
    requireDeadOwner(expected.expectedOwnerPid);
    // A prior attempt may have published this exact quarantine before failing
    // directory or audit synchronization. Keep its original authority intact.
    const recoveryId = entry.recovery?.recoveryId ?? randomUUID();
    const auditDirectory = path.join(
      path.dirname(location),
      `hedwig-budget-recovery-${entry.recovery ? randomUUID() : recoveryId}`
    );
    fs.mkdirSync(auditDirectory, { mode: 0o700 });
    syncParentDirectory(auditDirectory);
    durableExclusiveWrite(
      path.join(auditDirectory, "ledger.before.json"),
      before
    );
    durableExclusiveWrite(
      path.join(auditDirectory, "ledger.lock.before"),
      beforeLock
    );
    const recovery = entry.recovery ?? {
      disposition: "full_reservation_accounted",
      recoveryId,
      entryId: entry.id,
      previousStatus: entry.status,
      previousLedgerIntegrity: expected.expectedLedgerIntegrity,
      lockSha256: expected.expectedLockSha256,
      ownerPid: expected.expectedOwnerPid,
      reservedNanoUsd: entry.reservedNanoUsd,
      recoveredAt: new Date().toISOString(),
    };
    durableExclusiveWrite(
      path.join(auditDirectory, "recovery.json"),
      JSON.stringify(recovery, null, 2) + "\n"
    );
    // The recovery gate excludes other recoverers and new writers throughout takeover.
    const currentLockStat = fs.lstatSync(lockPath);
    if (
      !fs.readFileSync(location).equals(before) ||
      !fs.readFileSync(lockPath).equals(beforeLock) ||
      currentLockStat.dev !== lockStat.dev ||
      currentLockStat.ino !== lockStat.ino ||
      currentLockStat.birthtimeMs !== lockStat.birthtimeMs ||
      currentLockStat.mtimeMs !== lockStat.mtimeMs
    )
      fail("recovery_state_changed");
    requireDeadOwner(expected.expectedOwnerPid);
    retiredLock = { path: lockPath, bytes: beforeLock };
    fs.renameSync(lockPath, path.join(auditDirectory, "ledger.lock.retired"));
    syncParentDirectory(lockPath);
    syncParentDirectory(path.join(auditDirectory, "ledger.lock.retired"));
    unlock = lockLedger(location, gate.identity);
    if (hash(readLedger(location, plan)) !== expected.expectedLedgerIntegrity)
      fail("recovery_state_changed");
    entry.status = "uncertain";
    entry.recovery = recovery;
    writeLedger(location, ledger);
    const recoveredLedger = readLedger(location, plan);
    const recoveredSummary = summary(recoveredLedger);
    durableExclusiveWrite(
      path.join(auditDirectory, "recovery.applied.json"),
      JSON.stringify(
        {
          recoveryId,
          ledgerIntegrity: hash(recoveredLedger),
          summary: recoveredSummary,
        },
        null,
        2
      ) + "\n"
    );
    recoveryRecorded = true;
    return { auditDirectory, recoveryId, summary: recoveredSummary };
  } finally {
    try {
      if (unlock) unlock({ preserveLock: !recoveryRecorded });
      else if (retiredLock && !fs.existsSync(retiredLock.path)) {
        // A failed takeover must leave a dead-owner record for a later attempt.
        // Exclusive creation cannot replace a contender in the takeover gap.
        durableExclusiveWrite(retiredLock.path, retiredLock.bytes);
      }
    } finally {
      gate.release();
    }
  }
}

/** Explicit model/price amendment within the original cap, never a new budget. */
function amendBudgetPlan(filename, suppliedOldPlan, suppliedNewPlan) {
  const oldPlan = validatePlan(suppliedOldPlan);
  const newPlan = validatePlan(suppliedNewPlan);
  if (oldPlan.schemaVersion !== 1 || newPlan.schemaVersion !== 1)
    fail("extended_plan_amendment_refused");
  if (oldPlan.capNanoUsd !== newPlan.capNanoUsd) fail("cap_change_refused");
  const location = ledgerLocation(filename);
  const unlock = lockLedger(location);
  try {
    const ledger = readLedger(location, oldPlan);
    if (summary(ledger).blocked) fail("unsettled_request");
    const history = ledger.schemaVersion === 2 ? ledger.planHistory : [oldPlan];
    // Never reactivate an old plan: an already-created old guard must stay invalid.
    if (history.some((previous) => previous.planHash === newPlan.planHash))
      fail("invalid_plan");
    writeLedger(location, {
      ...ledger,
      schemaVersion: 2,
      planHash: newPlan.planHash,
      planHistory: [...history, newPlan],
      entries:
        ledger.schemaVersion === 1
          ? ledger.entries.map((entry) => ({
              ...entry,
              planHash: oldPlan.planHash,
            }))
          : ledger.entries,
    });
    return summary(readLedger(location, newPlan));
  } finally {
    unlock();
  }
}

function validExtensionRequest(request, previousCap) {
  return (
    object(request) &&
    Object.keys(request).sort().join(",") ===
      "approvalReference,approvedAt,approvedTotalNanoUsd,authorizationId,expectedLedgerIntegrity" &&
    typeof request.authorizationId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      request.authorizationId
    ) &&
    timestamp(request.approvedAt) &&
    typeof request.approvalReference === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9:/._# -]{0,199}$/.test(request.approvalReference) &&
    digest(request.expectedLedgerIntegrity) &&
    integer(request.approvedTotalNanoUsd) &&
    request.approvedTotalNanoUsd > previousCap
  );
}

function validateCapHistory(ledger) {
  if (
    !Array.isArray(ledger.capAuthorizations) ||
    !ledger.capAuthorizations.length ||
    ledger.planHistory[0].schemaVersion !== 1
  )
    fail("invalid_ledger");
  let authorizationIndex = 0;
  let previousEntryCount = 0;
  const authorizationIds = new Set();
  for (let index = 1; index < ledger.planHistory.length; index++) {
    const previous = ledger.planHistory[index - 1];
    const next = ledger.planHistory[index];
    if (next.schemaVersion === 1) {
      if (authorizationIndex || next.capNanoUsd !== previous.capNanoUsd)
        fail("invalid_ledger");
      continue;
    }
    const authorization = ledger.capAuthorizations[authorizationIndex];
    if (!object(authorization)) fail("invalid_ledger");
    const {
      previousPlanHash,
      previousCapNanoUsd,
      previousLedgerIntegrity,
      entryCount,
      entryPrefixHash,
      ...request
    } = authorization;
    if (
      !validExtensionRequest(
        { ...request, expectedLedgerIntegrity: previousLedgerIntegrity },
        previous.capNanoUsd
      ) ||
      previousPlanHash !== previous.planHash ||
      previousCapNanoUsd !== previous.capNanoUsd ||
      !integer(entryCount) ||
      entryCount < previousEntryCount ||
      entryCount > ledger.entries.length ||
      entryPrefixHash !== hash(ledger.entries.slice(0, entryCount)) ||
      authorizationIds.has(authorization.authorizationId) ||
      hash(extendedPlan(previous, authorization)) !== hash(next)
    )
      fail("invalid_ledger");
    const prefix = ledger.entries.slice(0, entryCount);
    const prefixCost = prefix.reduce(
      (sum, entry) => sum + accountedCost(entry),
      0
    );
    const priorPlanHashes = new Set(
      ledger.planHistory.slice(0, index).map((item) => item.planHash)
    );
    if (
      !integer(prefixCost) ||
      prefixCost > previous.capNanoUsd ||
      prefix.some(
        (entry) =>
          !priorPlanHashes.has(entry.planHash) ||
          (entry.status !== "settled" && !entry.recovery)
      )
    )
      fail("invalid_ledger");
    // Reconstruct the exact predecessor content, including every old entry and
    // earlier authorization. A recomputed outer checksum cannot hide a deletion.
    const predecessor = {
      ...ledger,
      schemaVersion: authorizationIndex === 0 ? 2 : 3,
      planHash: previous.planHash,
      capNanoUsd: previous.capNanoUsd,
      planHistory: ledger.planHistory.slice(0, index),
      entries: prefix,
    };
    if (authorizationIndex === 0) delete predecessor.capAuthorizations;
    else
      predecessor.capAuthorizations = ledger.capAuthorizations.slice(
        0,
        authorizationIndex
      );
    if (hash(predecessor) !== previousLedgerIntegrity) fail("invalid_ledger");
    authorizationIds.add(authorization.authorizationId);
    previousEntryCount = entryCount;
    authorizationIndex++;
  }
  if (authorizationIndex !== ledger.capAuthorizations.length)
    fail("invalid_ledger");
}

/** Operator-only total-cap increase. Approval metadata records, but cannot grant, consent. */
function extendBudgetCap(filename, suppliedPlan, request) {
  const oldPlan = validatePlan(suppliedPlan);
  if (!validExtensionRequest(request, oldPlan.capNanoUsd))
    fail("invalid_extension_request");
  const location = ledgerLocation(filename);
  const unlock = lockLedger(location);
  let commitAttempted = false;
  let completed = false;
  try {
    const ledger = readLedger(location, oldPlan);
    if (ledger.schemaVersion === 1) fail("legacy_ledger_extension_refused");
    if (hash(ledger) !== request.expectedLedgerIntegrity)
      fail("extension_state_changed");
    if (summary(ledger).blocked) fail("unsettled_request");
    const earlier = ledger.capAuthorizations ?? [];
    if (
      earlier.some((item) => item.authorizationId === request.authorizationId)
    )
      fail("duplicate_authorization");
    const before = fs.readFileSync(location);
    const { expectedLedgerIntegrity, ...approval } = request;
    const authorization = {
      ...approval,
      previousPlanHash: oldPlan.planHash,
      previousCapNanoUsd: oldPlan.capNanoUsd,
      previousLedgerIntegrity: expectedLedgerIntegrity,
      entryCount: ledger.entries.length,
      entryPrefixHash: hash(ledger.entries),
    };
    const plan = extendedPlan(oldPlan, authorization);
    const proposed = {
      ...ledger,
      schemaVersion: 3,
      planHash: plan.planHash,
      capNanoUsd: plan.capNanoUsd,
      planHistory: [...ledger.planHistory, plan],
      capAuthorizations: [...earlier, authorization],
    };
    validateCapHistory(proposed);
    const auditDirectory = path.join(
      path.dirname(location),
      `hedwig-budget-extension-${request.authorizationId}`
    );
    fs.mkdirSync(auditDirectory, { mode: 0o700 });
    syncParentDirectory(auditDirectory);
    durableExclusiveWrite(
      path.join(auditDirectory, "ledger.before.json"),
      before
    );
    durableExclusiveWrite(
      path.join(auditDirectory, "plan.proposed.json"),
      JSON.stringify(plan, null, 2) + "\n"
    );
    durableExclusiveWrite(
      path.join(auditDirectory, "extension.intent.json"),
      JSON.stringify(
        {
          authorization,
          proposedLedgerIntegrity: hash(proposed),
          proposedPlanHash: plan.planHash,
        },
        null,
        2
      ) + "\n"
    );
    if (
      !fs.readFileSync(location).equals(before) ||
      hash(readLedger(location, oldPlan)) !== expectedLedgerIntegrity
    )
      fail("extension_state_changed");
    commitAttempted = true;
    writeLedger(location, proposed);
    const applied = readLedger(location, plan);
    const result = summary(applied);
    durableExclusiveWrite(
      path.join(auditDirectory, "extension.applied.json"),
      JSON.stringify(
        {
          authorizationId: request.authorizationId,
          ledgerIntegrity: hash(applied),
          planHash: plan.planHash,
          summary: result,
        },
        null,
        2
      ) + "\n"
    );
    completed = true;
    return { auditDirectory, plan, summary: result };
  } finally {
    // A failed commit/readback/applied-receipt write retains the exclusion lock.
    // Recovery requires inspection of the audit files; rerunning is not recovery.
    unlock({ preserveLock: commitAttempted && !completed });
  }
}

// Reconciliation is an operator action, not a provider client. These checks bind
// already-fetched evidence; they cannot prove its authenticated origin or attribution.
function reconciliationKeys(value, required, optional = []) {
  return (
    object(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key)
    )
  );
}
function reconciliationUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value
    )
  );
}
function reconciliationJson(text, expectedHash, limit) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") > limit ||
    !digest(expectedHash) ||
    rawHash(text) !== expectedHash
  )
    fail("invalid_reconciliation_evidence");
  try {
    const parsed = JSON.parse(text);
    // Only a normalized metadata projection is admissible. JSON.parse alone
    // discards duplicate keys while their hidden text would survive in the audit.
    if (JSON.stringify(parsed) !== text)
      fail("invalid_reconciliation_evidence");
    return parsed;
  } catch {
    fail("invalid_reconciliation_evidence");
  }
}
function reconciliationModelMatches(requestedModel, reportedModel, proof) {
  if (reportedModel === requestedModel) return proof === undefined;
  return (
    reconciliationKeys(proof, [
      "schemaVersion",
      "provider",
      "endpoint",
      "httpStatus",
      "retrievedAt",
      "providerResponseSha256",
      "data",
    ]) &&
    proof.schemaVersion === 1 &&
    proof.provider === "openrouter" &&
    proof.endpoint === "https://openrouter.ai/api/v1/models" &&
    proof.httpStatus === 200 &&
    timestamp(proof.retrievedAt) &&
    proof.retrievedAt === RECONCILIATION_MODEL_IDENTITY.catalogRetrievedAt &&
    proof.providerResponseSha256 ===
      RECONCILIATION_MODEL_IDENTITY.catalogResponseSha256 &&
    reconciliationKeys(proof.data, ["id", "canonical_slug"]) &&
    proof.data.id === requestedModel &&
    proof.data.canonical_slug === reportedModel &&
    requestedModel === RECONCILIATION_MODEL_IDENTITY.requestedModel &&
    reportedModel === RECONCILIATION_MODEL_IDENTITY.canonicalModel
  );
}
function reconciliationEvidence(request, originalEntry, entryPlan) {
  const receipt = reconciliationJson(
    request.receiptJson,
    request.receiptSha256,
    4096
  );
  const attribution = reconciliationJson(
    request.attributionJson,
    request.attributionSha256,
    2048
  );
  const data = receipt?.data;
  if (
    !reconciliationKeys(
      receipt,
      [
        "schemaVersion",
        "provider",
        "endpoint",
        "httpStatus",
        "retrievedAt",
        "data",
      ],
      ["modelIdentity"]
    ) ||
    receipt.schemaVersion !== 1 ||
    receipt.provider !== "openrouter" ||
    receipt.endpoint !== "https://openrouter.ai/api/v1/generation" ||
    receipt.httpStatus !== 200 ||
    !timestamp(receipt.retrievedAt) ||
    !reconciliationKeys(
      data,
      [
        "id",
        "model",
        "api_type",
        "created_at",
        "total_cost",
        "cancelled",
        "finish_reason",
      ],
      ["usage", "request_id"]
    ) ||
    !validGenerationId(data.id) ||
    !reconciliationModelMatches(
      entryPlan.model,
      data.model,
      receipt.modelIdentity
    ) ||
    data.api_type !== "completions" ||
    typeof data.cancelled !== "boolean" ||
    !(
      ["stop", "length", "tool_calls", "content_filter", "error"].includes(
        data.finish_reason
      ) ||
      (data.cancelled && data.finish_reason === null)
    ) ||
    (data.request_id !== undefined &&
      (typeof data.request_id !== "string" ||
        !/^req-[A-Za-z0-9_-]{1,196}$/.test(data.request_id))) ||
    typeof data.created_at !== "string" ||
    data.created_at.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      data.created_at
    ) ||
    !Number.isFinite(Date.parse(data.created_at)) ||
    typeof data.total_cost !== "number" ||
    !Number.isFinite(data.total_cost) ||
    data.total_cost < 0
  )
    fail("invalid_reconciliation_evidence");
  const costNanoUsd = Math.ceil(data.total_cost * NANO_USD);
  if (
    !integer(costNanoUsd) ||
    costNanoUsd > originalEntry.reservedNanoUsd ||
    (data.usage !== undefined &&
      (typeof data.usage !== "number" ||
        !Number.isFinite(data.usage) ||
        data.usage < 0 ||
        Math.ceil(data.usage * NANO_USD) !== costNanoUsd))
  )
    fail("invalid_reconciliation_evidence");
  if (
    !reconciliationKeys(attribution, [
      "entryId",
      "generationId",
      "model",
      "method",
      "operatorReference",
      "reviewedAt",
      "uniqueMatchConfirmed",
      "finalCostConfirmed",
      "providerResponseSha256",
      "matchEvidenceSha256",
    ]) ||
    attribution.entryId !== originalEntry.id ||
    attribution.generationId !== data.id ||
    attribution.model !== entryPlan.model ||
    attribution.uniqueMatchConfirmed !== true ||
    attribution.finalCostConfirmed !== true ||
    !timestamp(attribution.reviewedAt) ||
    !digest(attribution.providerResponseSha256) ||
    !digest(attribution.matchEvidenceSha256) ||
    typeof attribution.operatorReference !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9:/._# -]{0,199}$/.test(
      attribution.operatorReference
    ) ||
    attribution.method !==
      (originalEntry.generationId
        ? "captured_generation_id"
        : "reviewed_unique_match") ||
    (originalEntry.generationId !== undefined &&
      originalEntry.generationId !== data.id)
  )
    fail("invalid_reconciliation_evidence");
  if (
    ![originalEntry.requestedAt, originalEntry.completedAt].every(timestamp) ||
    (originalEntry.responseReceivedAt !== undefined &&
      !timestamp(originalEntry.responseReceivedAt))
  )
    fail("invalid_reconciliation_evidence");
  const created = Date.parse(data.created_at),
    retrieved = Date.parse(receipt.retrievedAt);
  const started = Date.parse(originalEntry.requestedAt),
    response = Date.parse(originalEntry.responseReceivedAt),
    completed = Date.parse(originalEntry.completedAt);
  // Five seconds permits small provider/client clock skew, not loose date-based matching.
  if (
    completed < started ||
    (originalEntry.responseReceivedAt !== undefined &&
      (response < started || completed < response)) ||
    created < started - 5000 ||
    created > completed + 5000 ||
    retrieved < Math.max(created, completed) ||
    Date.parse(attribution.reviewedAt) < retrieved ||
    (receipt.modelIdentity !== undefined &&
      Date.parse(receipt.modelIdentity.retrievedAt) >
        Date.parse(attribution.reviewedAt)) ||
    (originalEntry.providerCreatedAt !== undefined &&
      Math.abs(Date.parse(originalEntry.providerCreatedAt) - created) > 1000)
  )
    fail("invalid_reconciliation_evidence");
  return {
    generationId: data.id,
    costNanoUsd,
    providerCreatedAt: new Date(created).toISOString(),
    reviewedAt: attribution.reviewedAt,
  };
}
function reconciliationOriginal(entry, plan) {
  return (
    reconciliationKeys(
      entry,
      [
        "id",
        "planHash",
        "maxTokens",
        "reservedNanoUsd",
        "status",
        "requestedAt",
        "completedAt",
      ],
      ["responseReceivedAt", "generationId", "providerCreatedAt"]
    ) &&
    entry.status === "uncertain" &&
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    entry.id.length <= 200 &&
    entry.planHash === plan.planHash &&
    integer(entry.maxTokens) &&
    entry.maxTokens > 0 &&
    entry.maxTokens <= plan.maxCompletionTokens &&
    entry.reservedNanoUsd === reservation(plan, entry.maxTokens) &&
    (entry.generationId === undefined ||
      validGenerationId(entry.generationId)) &&
    (entry.providerCreatedAt === undefined ||
      timestamp(entry.providerCreatedAt))
  );
}
function validateReconciliationRecord(ledger, entryIndex, entryPlan) {
  const entry = ledger.entries[entryIndex],
    record = entry.reconciliation,
    header = record?.previousLedgerHeader;
  if (
    ledger.schemaVersion !== 3 ||
    !reconciliationKeys(record, [
      "reconciliationId",
      "previousLedgerIntegrity",
      "previousLedgerHeader",
      "previousEntryCount",
      "entryIndex",
      "immutablePrefixCount",
      "originalEntry",
      "originalEntrySha256",
      "receiptJson",
      "receiptSha256",
      "attributionJson",
      "attributionSha256",
      "reconciledAt",
    ]) ||
    !reconciliationUuid(record.reconciliationId) ||
    !digest(record.previousLedgerIntegrity) ||
    !timestamp(record.reconciledAt) ||
    record.entryIndex !== entryIndex ||
    record.previousEntryCount !== entryIndex + 1 ||
    !reconciliationKeys(header, [
      "schemaVersion",
      "planHash",
      "capNanoUsd",
      "planHistory",
      "capAuthorizations",
    ]) ||
    header.schemaVersion !== 3 ||
    !Array.isArray(header.planHistory) ||
    !header.planHistory.length ||
    !Array.isArray(header.capAuthorizations) ||
    !header.capAuthorizations.length ||
    hash(header.planHistory) !==
      hash(ledger.planHistory.slice(0, header.planHistory.length)) ||
    hash(header.capAuthorizations) !==
      hash(
        ledger.capAuthorizations.slice(0, header.capAuthorizations.length)
      ) ||
    header.planHash !== header.planHistory.at(-1).planHash ||
    header.capNanoUsd !== header.planHistory.at(-1).capNanoUsd ||
    record.immutablePrefixCount !==
      header.capAuthorizations.at(-1).entryCount ||
    entryIndex < record.immutablePrefixCount ||
    !reconciliationOriginal(record.originalEntry, entryPlan) ||
    record.originalEntrySha256 !== hash(record.originalEntry)
  )
    fail("invalid_reconciliation_record");
  const verified = reconciliationEvidence(
    record,
    record.originalEntry,
    entryPlan
  );
  if (Date.parse(record.reconciledAt) < Date.parse(verified.reviewedAt))
    fail("invalid_reconciliation_record");
  const expected = {
    ...record.originalEntry,
    status: "settled",
    costNanoUsd: verified.costNanoUsd,
    generationId: verified.generationId,
    providerCreatedAt:
      record.originalEntry.providerCreatedAt ?? verified.providerCreatedAt,
    reconciliation: record,
  };
  if (
    hash(expected) !== hash(entry) ||
    ledger.entries.filter((item) => item.generationId === verified.generationId)
      .length !== 1 ||
    ledger.entries.filter(
      (item) =>
        item.reconciliation?.reconciliationId === record.reconciliationId
    ).length !== 1
  )
    fail("invalid_reconciliation_record");
  const previous = {
    ...header,
    entries: ledger.entries
      .slice(0, record.previousEntryCount)
      .map((item, index) =>
        index === entryIndex ? record.originalEntry : item
      ),
  };
  if (hash(previous) !== record.previousLedgerIntegrity)
    fail("invalid_reconciliation_record");
  validateCapHistory(previous);
}

/** Explicit local settlement of a reviewed, finalized provider receipt; never a network call. */
function reconcileBudgetEntry(filename, suppliedPlan, request) {
  const plan = validatePlan(suppliedPlan);
  if (
    !reconciliationKeys(request, [
      "reconciliationId",
      "expectedLedgerIntegrity",
      "expectedEntryId",
      "expectedReservationNanoUsd",
      "receiptJson",
      "expectedReceiptSha256",
      "attributionJson",
      "expectedAttributionSha256",
    ]) ||
    !reconciliationUuid(request.reconciliationId) ||
    !digest(request.expectedLedgerIntegrity) ||
    typeof request.expectedEntryId !== "string" ||
    !request.expectedEntryId ||
    request.expectedEntryId.length > 200 ||
    !integer(request.expectedReservationNanoUsd) ||
    !request.expectedReservationNanoUsd
  )
    fail("invalid_reconciliation_request");
  const location = ledgerLocation(filename),
    unlock = lockLedger(location);
  let commitAttempted = false,
    completed = false;
  try {
    const ledger = readLedger(location, plan);
    if (hash(ledger) !== request.expectedLedgerIntegrity)
      fail("reconciliation_state_changed");
    const entryIndex = ledger.entries.findIndex(
      (entry) => entry.id === request.expectedEntryId
    );
    const entry = ledger.entries[entryIndex];
    const entryPlan = ledger.planHistory?.find(
      (item) => item.planHash === entry?.planHash
    );
    const immutablePrefixCount = ledger.capAuthorizations?.at(-1)?.entryCount;
    const { entries: _entries, ...previousLedgerHeader } = ledger;
    if (
      ledger.schemaVersion !== 3 ||
      !entryPlan ||
      entryIndex !== ledger.entries.length - 1 ||
      !integer(immutablePrefixCount) ||
      entryIndex < immutablePrefixCount ||
      !reconciliationOriginal(entry, entryPlan) ||
      !reconciliationKeys(previousLedgerHeader, [
        "schemaVersion",
        "planHash",
        "capNanoUsd",
        "planHistory",
        "capAuthorizations",
      ])
    )
      fail("ineligible_reconciliation");
    if (entry.reservedNanoUsd !== request.expectedReservationNanoUsd)
      fail("reconciliation_state_changed");
    const record = {
      reconciliationId: request.reconciliationId,
      previousLedgerIntegrity: request.expectedLedgerIntegrity,
      previousLedgerHeader,
      previousEntryCount: ledger.entries.length,
      entryIndex,
      immutablePrefixCount,
      originalEntry: entry,
      originalEntrySha256: hash(entry),
      receiptJson: request.receiptJson,
      receiptSha256: request.expectedReceiptSha256,
      attributionJson: request.attributionJson,
      attributionSha256: request.expectedAttributionSha256,
      reconciledAt: new Date().toISOString(),
    };
    const verified = reconciliationEvidence(record, entry, entryPlan);
    if (
      ledger.entries.some(
        (item, index) =>
          index !== entryIndex && item.generationId === verified.generationId
      )
    )
      fail("duplicate_generation_id");
    if (
      ledger.entries.some(
        (item) =>
          item.reconciliation?.reconciliationId === request.reconciliationId ||
          (item.reconciliation &&
            item.reconciliation.receiptSha256 === request.expectedReceiptSha256)
      )
    )
      fail("duplicate_reconciliation");
    const settled = {
      ...entry,
      status: "settled",
      costNanoUsd: verified.costNanoUsd,
      generationId: verified.generationId,
      providerCreatedAt: entry.providerCreatedAt ?? verified.providerCreatedAt,
      reconciliation: record,
    };
    const proposed = {
      ...ledger,
      entries: [...ledger.entries.slice(0, entryIndex), settled],
    };
    validateReconciliationRecord(proposed, entryIndex, entryPlan);
    validateCapHistory(proposed);
    const before = fs.readFileSync(location);
    const auditDirectory = path.join(
      path.dirname(location),
      `hedwig-budget-reconciliation-${request.reconciliationId}`
    );
    fs.mkdirSync(auditDirectory, { mode: 0o700 });
    syncParentDirectory(auditDirectory);
    durableExclusiveWrite(
      path.join(auditDirectory, "ledger.before.json"),
      before
    );
    durableExclusiveWrite(
      path.join(auditDirectory, "provider-receipt.json"),
      request.receiptJson
    );
    durableExclusiveWrite(
      path.join(auditDirectory, "attribution.json"),
      request.attributionJson
    );
    durableExclusiveWrite(
      path.join(auditDirectory, "reconciliation.intent.json"),
      JSON.stringify(
        {
          reconciliationId: request.reconciliationId,
          previousLedgerIntegrity: request.expectedLedgerIntegrity,
          proposedLedgerIntegrity: hash(proposed),
          entryId: entry.id,
          receiptSha256: record.receiptSha256,
          attributionSha256: record.attributionSha256,
          costNanoUsd: verified.costNanoUsd,
        },
        null,
        2
      ) + "\n"
    );
    if (
      !fs.readFileSync(location).equals(before) ||
      hash(readLedger(location, plan)) !== request.expectedLedgerIntegrity
    )
      fail("reconciliation_state_changed");
    commitAttempted = true;
    writeLedger(location, proposed);
    const applied = readLedger(location, plan);
    if (hash(applied) !== hash(proposed)) fail("reconciliation_state_changed");
    const result = summary(applied);
    durableExclusiveWrite(
      path.join(auditDirectory, "reconciliation.applied.json"),
      JSON.stringify(
        {
          reconciliationId: request.reconciliationId,
          ledgerIntegrity: hash(applied),
          entryId: entry.id,
          summary: result,
        },
        null,
        2
      ) + "\n"
    );
    completed = true;
    return {
      auditDirectory,
      reconciliationId: request.reconciliationId,
      summary: result,
    };
  } finally {
    unlock({ preserveLock: commitAttempted && !completed });
  }
}

function boundedRequest(init, plan, reasoningProfile) {
  if (init?.method !== "POST" || typeof init.body !== "string")
    fail("request_rejected");
  let body;
  try {
    body = JSON.parse(init.body);
  } catch {
    fail("request_rejected");
  }
  const keys = [
    "model",
    "stream",
    "temperature",
    "reasoning",
    "max_tokens",
    "provider",
    "messages",
    "response_format",
  ];
  if (
    !object(body) ||
    Object.keys(body).some((key) => !keys.includes(key)) ||
    body.model !== plan.model ||
    body.stream !== false ||
    (body.temperature !== undefined && body.temperature !== 0) ||
    !integer(body.max_tokens) ||
    !body.max_tokens ||
    body.max_tokens > plan.maxCompletionTokens
  )
    fail("request_rejected");
  if (reasoningProfile) {
    if (
      body.temperature !== undefined ||
      body.max_tokens !== reasoningProfile.maxTokens ||
      !object(body.reasoning) ||
      hash(body.reasoning) !== hash(reasoningProfile.reasoning)
    )
      fail("request_rejected");
  } else if (body.reasoning !== undefined) {
    fail("request_rejected");
  }
  const provider = body.provider;
  const policy = {
    data_collection: "deny",
    require_parameters: true,
    allow_fallbacks: false,
    zdr: true,
  };
  if (
    !object(provider) ||
    Object.keys(provider).some(
      (key) => ![...Object.keys(policy), "max_price"].includes(key)
    ) ||
    Object.entries(policy).some(([key, value]) => provider[key] !== value) ||
    (provider.max_price !== undefined &&
      hash(provider.max_price) !== hash(plan.maxPrice))
  )
    fail("request_rejected");
  if (
    !Array.isArray(body.messages) ||
    !body.messages.length ||
    body.messages.some(
      (message) =>
        !object(message) ||
        Object.keys(message).some(
          (key) => !["role", "content"].includes(key)
        ) ||
        !["system", "user", "assistant"].includes(message.role) ||
        typeof message.content !== "string"
    )
  )
    fail("request_rejected");
  if (
    !object(body.response_format) ||
    body.response_format.type !== "json_schema" ||
    Object.keys(body.response_format).some(
      (key) => !["type", "json_schema"].includes(key)
    ) ||
    !object(body.response_format.json_schema)
  )
    fail("request_rejected");
  return { ...body, provider: { ...policy, max_price: plan.maxPrice } };
}
function validGenerationId(value) {
  return typeof value === "string" && /^gen-[A-Za-z0-9_-]{1,196}$/.test(value);
}
async function responseReceipt(response, deadlineMs, headerGenerationId) {
  const reader = response.clone().body?.getReader();
  if (!reader) return undefined;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("deadline")), deadlineMs);
  });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) return undefined;
      chunks.push(value);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const receipt = { cost: response.ok ? payload?.usage?.cost : undefined };
    if (
      headerGenerationId !== undefined &&
      payload?.id !== undefined &&
      payload.id !== headerGenerationId
    )
      receipt.identityConflict = true;
    if (validGenerationId(payload?.id)) receipt.generationId = payload.id;
    if (integer(payload?.created)) {
      const created = new Date(payload.created * 1000);
      if (Number.isFinite(created.getTime()))
        receipt.providerCreatedAt = created.toISOString();
    }
    return receipt;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function installBudgetGuard({
  ledgerPath,
  plan: suppliedPlan,
  fetch: fetcher = globalThis.fetch,
  onDiagnostic = () => {},
}) {
  const plan = validatePlan(suppliedPlan);
  const reasoningProfile = REASONING_PROFILES.get(plan.model);
  const filename = ledgerLocation(ledgerPath);
  readLedger(filename, plan);
  function diagnostic(code) {
    try {
      onDiagnostic(code);
    } catch {
      /* Observability cannot release a reservation. */
    }
  }
  const guarded = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input?.url;
    if (url !== ENDPOINT) {
      if (typeof url === "string" && new URL(url).hostname === "openrouter.ai")
        fail("request_rejected");
      return fetcher(input, init);
    }
    const body = boundedRequest(init, plan, reasoningProfile);
    // Price caps change the adapter's already-measured body. Bound exactly the
    // final serialization before creating a reservation or starting a request.
    const serializedBody = JSON.stringify(body);
    if (Buffer.byteLength(serializedBody, "utf8") > REQUEST_LIMIT)
      fail("request_too_large");
    const unlock = lockLedger(filename);
    let dispatched = false;
    let outcomeRecorded = false;
    let reservationBaseline;
    try {
      const ledger = readLedger(filename, plan);
      if (summary(ledger).blocked) fail("unsettled_request");
      const reservedNanoUsd = reservation(plan, body.max_tokens);
      const accountedNanoUsd = ledger.entries.reduce(
        (sum, entry) => sum + accountedCost(entry),
        0
      );
      if (reservedNanoUsd > plan.capNanoUsd - accountedNanoUsd)
        fail("cap_exhausted");
      reservationBaseline = hash(ledger);
      const entry = {
        id: randomUUID(),
        ...(ledger.schemaVersion >= 2 ? { planHash: plan.planHash } : {}),
        maxTokens: body.max_tokens,
        reservedNanoUsd,
        status: "reserved",
        requestedAt: new Date().toISOString(),
      };
      ledger.entries.push(entry);
      writeLedger(filename, ledger);
      let response;
      try {
        dispatched = true;
        response = await fetcher(ENDPOINT, {
          ...init,
          redirect: "error",
          body: serializedBody,
        });
      } catch {
        entry.status = "uncertain";
        entry.completedAt = new Date().toISOString();
        writeLedger(filename, ledger);
        outcomeRecorded = true;
        fail("request_uncertain");
      }
      entry.responseReceivedAt = new Date().toISOString();
      // Capture bounded metadata durably before cloning/reading the body: a
      // cancellation can otherwise discard both cost and the reconciliation ID.
      const headerGenerationId = response.headers?.get("x-generation-id");
      if (validGenerationId(headerGenerationId))
        entry.generationId = headerGenerationId;
      writeLedger(filename, ledger);
      const receipt = await responseReceipt(
        response,
        reasoningProfile?.deadlineMs ?? RESPONSE_DEADLINE_MS,
        entry.generationId
      );
      entry.completedAt = new Date().toISOString();
      if (receipt?.identityConflict) {
        entry.status = "uncertain";
        entry.receiptIssue = "generation_id_conflict";
        writeLedger(filename, ledger);
        outcomeRecorded = true;
        fail("generation_id_conflict");
      }
      if (receipt?.generationId) entry.generationId = receipt.generationId;
      if (receipt?.providerCreatedAt)
        entry.providerCreatedAt = receipt.providerCreatedAt;
      const cost = receipt?.cost;
      const costNanoUsd =
        typeof cost === "number" && Number.isFinite(cost) && cost >= 0
          ? Math.ceil(cost * NANO_USD)
          : undefined;
      if (integer(costNanoUsd) && costNanoUsd <= reservedNanoUsd) {
        entry.status = "settled";
        entry.costNanoUsd = costNanoUsd;
      } else {
        entry.status = "uncertain";
        diagnostic("cost_unverified");
      }
      writeLedger(filename, ledger);
      outcomeRecorded = true;
      return response;
    } finally {
      let preserveLock = reservationBaseline !== undefined && !outcomeRecorded;
      if (preserveLock && !dispatched) {
        try {
          // A failed temp write or rename can prove no reservation appeared.
          // Any changed or unreadable state retains exclusion for recovery.
          preserveLock =
            hash(readLedger(filename, plan)) !== reservationBaseline;
        } catch {
          /* Ambiguous publication must retain the owner lock. */
        }
      }
      unlock({ preserveLock });
    }
  };
  return async (input, init) => {
    try {
      return await guarded(input, init);
    } catch (error) {
      const match = /^hedwig-budget: code=([a-z_]+)$/.exec(
        error?.message || ""
      );
      const code = match ? match[1] : "ledger_failure";
      diagnostic(code);
      fail(code);
    }
  };
}

module.exports = {
  createBudgetPlan,
  initializeBudgetLedger,
  amendBudgetPlan,
  extendBudgetCap,
  reconcileBudgetEntry,
  qualifyExistingBudgetPlan,
  readBudgetSummary,
  recoverInterruptedReservation,
  installBudgetGuard,
};

if (process.env.HEDWIG_EVAL_BUDGET_PRELOAD === "1") {
  try {
    const planPath = process.env.HEDWIG_EVAL_BUDGET_PLAN;
    const ledgerPath = process.env.HEDWIG_EVAL_BUDGET_LEDGER;
    if (!planPath || !path.isAbsolute(planPath) || !ledgerPath)
      fail("invalid_configuration");
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    globalThis.fetch = installBudgetGuard({
      ledgerPath,
      plan,
      onDiagnostic: (code) =>
        process.stderr.write(`hedwig-budget: code=${code}\n`),
    });
  } catch {
    process.stderr.write("hedwig-budget: code=initialization_failed\n");
    process.exit(1);
  }
}
