import {
  foldVerdict,
  type ConditionStatus,
  type EvidenceClass,
  type Verdict,
} from "./fold";
import { deepFreeze, describe, truncate } from "./catalog";
import type {
  Catalog,
  ConditionDefinition,
  ConsultRequest,
  Policy,
} from "./catalog";
import {
  MAX_CONDITION_ID_LENGTH,
  MAX_EXTRA_CONDITIONS,
  MAX_INPUT_JSON_LENGTH,
} from "./constants";
import { bandOf, supportOf } from "./support";
import type { Band, ConditionResult } from "./types";

// The one question every ConsultResponse answers, always the same text: a
// caller acts on `proceed`, never on parsing `verdict` or `results` itself.
const RESPONSE_QUESTION =
  "Should this agent proceed with this payment under the owner's policy?" as const;

export interface ConsultResponse {
  readonly question: typeof RESPONSE_QUESTION;
  readonly proceed: boolean;
  readonly verdict: Verdict;
  readonly support: number;
  readonly band: Band;
  readonly results: readonly ConditionResult[];
  readonly floorIds: readonly string[];
  readonly advisory: true;
}

const VALID_STATUSES: ConditionStatus[] = ["PASS", "FAIL", "UNVERIFIED"];
const VALID_EVIDENCE_CLASSES: EvidenceClass[] = [
  "onchain-read",
  "owner-policy",
  "static-registry",
  "not-verifiable",
];

const CORE_REFERENCE = "consult/references/core.md";

// A row this core decides on its own, with no Condition behind it: a broken
// catalog, an unknown action type, a malformed input. Always UNVERIFIED,
// always resting on nothing verified.
function coreResult(
  id: string,
  code: string,
  question: string,
  evidence: string
): ConditionResult {
  return {
    id,
    question,
    status: "UNVERIFIED",
    code,
    evidence,
    evidenceClass: "not-verifiable",
    reference: CORE_REFERENCE,
  };
}

// Every malformed-result path answers UNVERIFIED: a checker earning PASS or
// FAIL has to say so correctly, or it has not earned either.
function malformedResult(
  definition: ConditionDefinition,
  code: string,
  evidence: string
): ConditionResult {
  return {
    id: definition.id,
    question: definition.question,
    status: "UNVERIFIED",
    code,
    evidence,
    evidenceClass: "not-verifiable",
    reference: definition.reference,
  };
}

function codeDeclaredForStatus(
  definition: ConditionDefinition,
  status: string,
  code: string
): boolean {
  if (status === "PASS") return code === definition.codes.pass;
  if (status === "FAIL") return definition.codes.fail.includes(code);
  if (status === "UNVERIFIED")
    return definition.codes.unverified.includes(code);
  return false;
}

// A checker is a black box: its return value is data from an untrusted
// caller-supplied function, not a trusted internal type. Every field is
// read out of it exactly once into a local, so a getter cannot answer one
// way during validation and another way to a later reader; what consult()
// actually returns is a fresh object built from those locals, never the
// checker's own live object. question and reference always come from the
// catalog's own definition, never from the checker.
function runChecker(
  definition: ConditionDefinition,
  request: ConsultRequest,
  policy: Policy
): ConditionResult {
  let outcome: unknown;
  try {
    outcome = definition.check(request, { policy });
  } catch (error) {
    return malformedResult(
      definition,
      "CHECKER_THREW",
      describeCheckerError(error)
    );
  }

  if (isThenable(outcome)) {
    return malformedResult(
      definition,
      "RESULT_MALFORMED",
      "checker returned a thenable instead of a synchronous result"
    );
  }
  if (
    outcome === null ||
    typeof outcome !== "object" ||
    Array.isArray(outcome)
  ) {
    return malformedResult(
      definition,
      "RESULT_MALFORMED",
      "checker returned a malformed result"
    );
  }

  const record = outcome as Record<string, unknown>;
  const rawId = record.id;
  const rawStatus = record.status;
  const rawCode = record.code;
  const rawEvidence = record.evidence;
  const rawEvidenceClass = record.evidenceClass;

  if (
    typeof rawId !== "string" ||
    typeof rawStatus !== "string" ||
    typeof rawCode !== "string" ||
    typeof rawEvidence !== "string" ||
    typeof rawEvidenceClass !== "string"
  ) {
    return malformedResult(
      definition,
      "RESULT_MALFORMED",
      "checker returned a malformed result"
    );
  }
  if (rawId !== definition.id) {
    return malformedResult(
      definition,
      "RESULT_MALFORMED",
      `checker returned id "${describe(rawId)}" instead of "${definition.id}"`
    );
  }
  if (!VALID_STATUSES.includes(rawStatus as ConditionStatus)) {
    return malformedResult(
      definition,
      "RESULT_MALFORMED",
      `checker returned an unrecognised status "${describe(rawStatus)}"`
    );
  }
  if (!VALID_EVIDENCE_CLASSES.includes(rawEvidenceClass as EvidenceClass)) {
    return malformedResult(
      definition,
      "RESULT_MALFORMED",
      `checker returned an unrecognised evidence class "${describe(
        rawEvidenceClass
      )}"`
    );
  }
  if (!codeDeclaredForStatus(definition, rawStatus, rawCode)) {
    return malformedResult(
      definition,
      "RESULT_MALFORMED",
      `checker returned an undeclared code "${describe(
        rawCode
      )}" for status "${rawStatus}"`
    );
  }
  // A PASS resting on evidence the core has no way to verify is a
  // contradiction: the status claims proof, the evidence class admits
  // there is none.
  if (rawStatus === "PASS" && rawEvidenceClass === "not-verifiable") {
    return malformedResult(
      definition,
      "RESULT_MALFORMED",
      "a PASS cannot rest on unverifiable evidence"
    );
  }

  return {
    id: rawId,
    question: definition.question,
    status: rawStatus as ConditionStatus,
    code: rawCode,
    evidence: rawEvidence,
    evidenceClass: rawEvidenceClass as EvidenceClass,
    reference: definition.reference,
  };
}

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function describeCheckerError(error: unknown): string {
  try {
    return error instanceof Error
      ? error.constructor?.name ?? "Error"
      : "unknown error";
  } catch {
    return "unknown error";
  }
}

// Never throws, even on a value with no constructor (a thrown
// Object.create(null)) or a getter that throws on access of its own
// properties: this is the last line of defence before returning to a caller.
function describeInputError(error: unknown): string {
  try {
    if (error instanceof Error) {
      return error.message
        ? describe(error.message)
        : error.constructor?.name ?? "Error";
    }
    return typeof error;
  } catch {
    return "unknown error";
  }
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readConditionIds(request: Record<string, unknown>): {
  ids: string[];
  extraResult?: ConditionResult;
} {
  const conditions = request.conditions;
  if (conditions === undefined) {
    return { ids: [] };
  }
  // Each named id becomes a result, so the list and every id are bounded:
  // a small request must never buy a large response.
  if (
    Array.isArray(conditions) &&
    conditions.length <= MAX_EXTRA_CONDITIONS &&
    conditions.every(
      (id) => typeof id === "string" && id.length <= MAX_CONDITION_ID_LENGTH
    )
  ) {
    // Dedupe: a repeated id must not run its checker twice.
    return { ids: [...new Set(conditions)] };
  }
  return {
    ids: [],
    extraResult: coreResult(
      "input-shape",
      "INPUT_SHAPE_INVALID",
      "Is the request and policy shape valid?",
      `conditions must be an array of at most ${MAX_EXTRA_CONDITIONS} strings, each at most ${MAX_CONDITION_ID_LENGTH} characters`
    ),
  };
}

const STATUS_RANK: Record<ConditionStatus, number> = {
  FAIL: 0,
  UNVERIFIED: 1,
  PASS: 2,
};

// FAIL first, then UNVERIFIED, then PASS; stable within a group (catalog
// order), since Array.prototype.sort is a stable sort.
function sortWorstFirst(
  results: readonly ConditionResult[]
): ConditionResult[] {
  return [...results].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]
  );
}

const ABSTENTION_PREFIX = "cannot confirm";

// Every UNVERIFIED row says so in the same fixed words, applied centrally
// here rather than by every checker remembering to write it: a caller can
// recognise an abstention by its opening words alone, from any Condition or
// core-level defect.
function withAbstentionWording(result: ConditionResult): string {
  if (result.status !== "UNVERIFIED") {
    return result.evidence;
  }
  if (result.evidence.toLowerCase().startsWith(ABSTENTION_PREFIX)) {
    return result.evidence;
  }
  return `${ABSTENTION_PREFIX}: ${result.evidence}`;
}

// A single checker message can embed more than one caller-derived value
// (an amount and a cap, a chain id on each side); truncating each value on
// the way in is not enough to bound the composed sentence, so every
// evidence string is capped again, once, right before it leaves consult().
function finalizeResponse(
  results: ConditionResult[],
  floorIds: string[],
  policyPermits: boolean,
  weights?: Readonly<Record<EvidenceClass, number>>
): ConsultResponse {
  const cappedResults: ConditionResult[] = results.map((result) => ({
    ...result,
    evidence: truncate(withAbstentionWording(result)),
  }));

  // The verdict is decided first, from the checks alone: foldVerdict reads
  // only `.status` off each result and has never heard of `support`.
  const verdict = foldVerdict(cappedResults, policyPermits);
  const sortedResults = Object.freeze(
    sortWorstFirst(cappedResults).map((result) => Object.freeze(result))
  );

  // The number is computed AFTER the verdict, never before it and never as
  // an input to it.
  const floorRan = floorIds.length > 0;
  const support = supportOf(verdict, sortedResults, floorRan, weights);
  const band = bandOf(support);

  return Object.freeze({
    question: RESPONSE_QUESTION,
    proceed: verdict === "ALLOW_UNDER_POLICY",
    verdict,
    support,
    band,
    results: sortedResults,
    floorIds: Object.freeze([...floorIds]),
    advisory: true as const,
  });
}

// One named UNVERIFIED result, no Floor ran: shared by every early exit
// (a broken catalog, an unknown action type, a catalog with no Floor, a
// malformed or oversized input).
function singleResultResponse(
  result: ConditionResult,
  extraResults: ConditionResult[],
  policyPermits: boolean,
  weights?: Readonly<Record<EvidenceClass, number>>
): ConsultResponse {
  return finalizeResponse(
    [result, ...extraResults],
    [],
    policyPermits,
    weights
  );
}

export function unknownResponse(
  code: string,
  evidence: string
): ConsultResponse {
  return singleResultResponse(
    coreResult(
      "input-shape",
      code,
      "Is the request and policy shape valid?",
      evidence
    ),
    [],
    false
  );
}

function isOversized(value: unknown): boolean {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" && json.length > MAX_INPUT_JSON_LENGTH;
  } catch {
    // A value that cannot be serialised cannot be measured, so it is refused.
    return true;
  }
}

function runConsult(
  catalog: Catalog,
  requestInput: unknown,
  policyInput: unknown,
  weights?: Readonly<Record<EvidenceClass, number>>
): ConsultResponse {
  // Deep-frozen structured clones, read first: every field below comes only
  // from these clones, never again from requestInput or policyInput, so a
  // checker (or consult itself) can never see one value while deciding and
  // a different value while acting on the same request. Size is measured
  // on the clone rather than the raw input for the same reason: measuring
  // the raw input would read a hostile getter a second time.
  const clonedRequest = structuredClone(requestInput);
  const clonedPolicy = structuredClone(policyInput);

  if (isOversized(clonedRequest) || isOversized(clonedPolicy)) {
    return unknownResponse(
      "INPUT_TOO_LARGE",
      "request or policy JSON exceeds the size limit"
    );
  }

  const request = deepFreeze(clonedRequest) as unknown as ConsultRequest;
  const policy = deepFreeze(clonedPolicy) as unknown as Policy;

  const requestObj = requireObject(request, "request");
  const actionObj = requireObject(requestObj.action, "request.action");
  const policyObj = requireObject(policy, "policy");
  const policyPermits = policyObj.permits === true;

  const { ids: extraIdsRaw, extraResult } = readConditionIds(requestObj);
  const extraResults = extraResult ? [extraResult] : [];

  const type = actionObj.type;
  const conditions =
    typeof type === "string" &&
    Object.hasOwn(catalog, type) &&
    Array.isArray((catalog as Record<string, unknown>)[type])
      ? (catalog as Record<string, readonly ConditionDefinition[]>)[type]
      : undefined;

  if (conditions === undefined) {
    return singleResultResponse(
      coreResult(
        "action-type",
        "ACTION_TYPE_UNKNOWN",
        "Is the action type in the catalog?",
        `action type "${describe(type)}" is not in the catalog`
      ),
      extraResults,
      policyPermits,
      weights
    );
  }

  const floor = conditions.filter((condition) => condition.isFloor === true);
  const floorIds = floor.map((condition) => condition.id);

  if (floorIds.length === 0) {
    return singleResultResponse(
      coreResult(
        "floor",
        "FLOOR_MISSING",
        "Does the catalog have a mandatory Floor for this action type?",
        "no floor for action type"
      ),
      extraResults,
      policyPermits,
      weights
    );
  }

  const extraIds = extraIdsRaw.filter((id) => !floorIds.includes(id));

  const results: ConditionResult[] = [
    ...floor.map((definition) => runChecker(definition, request, policy)),
    ...extraIds.map((id): ConditionResult => {
      const definition = conditions.find((condition) => condition.id === id);
      if (definition === undefined) {
        return coreResult(
          id,
          "CONDITION_UNKNOWN",
          "Is the named condition in the catalog for this action type?",
          `condition "${describe(
            id
          )}" is not in the catalog for action type "${describe(type)}"`
        );
      }
      return runChecker(definition, request, policy);
    }),
    ...extraResults,
  ];

  return finalizeResponse(results, floorIds, policyPermits, weights);
}

/**
 * Binds a catalog to a `(request, policy) => ConsultResponse` function.
 * Never throws: a malformed request or policy resolves to UNKNOWN with an
 * "input-shape" result naming the defect.
 *
 * `weights` is not part of the public door: it exists only so tests can
 * prove the verdict never moves when the evidence-class weight table does
 * (see consult/src/internal.ts). Production always uses the real table.
 */
export function makeConsult(
  catalog: Catalog,
  weights?: Readonly<Record<EvidenceClass, number>>
): (request: ConsultRequest, policy: Policy) => ConsultResponse {
  return function consultBound(
    requestInput: unknown,
    policyInput: unknown
  ): ConsultResponse {
    try {
      return runConsult(catalog, requestInput, policyInput, weights);
    } catch (error) {
      return unknownResponse("INPUT_SHAPE_INVALID", describeInputError(error));
    }
  };
}
