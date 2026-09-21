import {
  foldVerdict,
  type ConditionResult,
  type ConditionStatus,
  type Verdict,
} from "./fold";
import { deepFreeze, describe, truncate } from "./catalog";
import type {
  Catalog,
  ConditionDefinition,
  ConsultRequest,
  Policy,
} from "./catalog";

export interface ConsultResponse {
  verdict: Verdict;
  results: readonly ConditionResult[];
  floorIds: readonly string[];
  advisory: true;
}

const VALID_STATUSES: ConditionStatus[] = ["PASS", "FAIL", "UNVERIFIED"];

// A checker is a black box: its return value is data from an untrusted
// caller-supplied function, not a trusted internal type. Every field is
// read out of it exactly once into a local, so a getter cannot answer one
// way during validation and another way to a later reader; what consult()
// actually returns is a fresh object built from those locals, never the
// checker's own live object.
function runChecker(
  definition: ConditionDefinition,
  request: ConsultRequest,
  policy: Policy
): ConditionResult {
  let outcome: unknown;
  try {
    outcome = definition.check(request, { policy });
  } catch (error) {
    return {
      id: definition.id,
      status: "UNVERIFIED",
      evidence: describeCheckerError(error),
    };
  }

  if (isThenable(outcome)) {
    return {
      id: definition.id,
      status: "UNVERIFIED",
      evidence: "checker returned a thenable instead of a synchronous result",
    };
  }
  if (
    outcome === null ||
    typeof outcome !== "object" ||
    Array.isArray(outcome)
  ) {
    return {
      id: definition.id,
      status: "UNVERIFIED",
      evidence: "checker returned a malformed result",
    };
  }

  const record = outcome as Record<string, unknown>;
  const rawId = record.id;
  const rawStatus = record.status;
  const rawEvidence = record.evidence;

  if (
    typeof rawId !== "string" ||
    typeof rawStatus !== "string" ||
    typeof rawEvidence !== "string"
  ) {
    return {
      id: definition.id,
      status: "UNVERIFIED",
      evidence: "checker returned a malformed result",
    };
  }
  if (rawId !== definition.id) {
    return {
      id: definition.id,
      status: "UNVERIFIED",
      evidence: `checker returned id "${describe(rawId)}" instead of "${
        definition.id
      }"`,
    };
  }
  if (!VALID_STATUSES.includes(rawStatus as ConditionStatus)) {
    return {
      id: definition.id,
      status: "UNVERIFIED",
      evidence: `checker returned an unrecognised status "${describe(
        rawStatus
      )}"`,
    };
  }
  return {
    id: rawId,
    status: rawStatus as ConditionStatus,
    evidence: rawEvidence,
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

const MAX_EXTRA_CONDITIONS = 32;
const MAX_CONDITION_ID_LENGTH = 64;

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
    extraResult: {
      id: "input-shape",
      status: "UNVERIFIED",
      evidence: `conditions must be an array of at most ${MAX_EXTRA_CONDITIONS} strings, each at most ${MAX_CONDITION_ID_LENGTH} characters`,
    },
  };
}

// A single checker message can embed more than one caller-derived value
// (an amount and a cap, a chain id on each side); truncating each value on
// the way in is not enough to bound the composed sentence, so every
// evidence string is capped again, once, right before it leaves consult().
function finalizeResponse(
  results: ConditionResult[],
  floorIds: string[],
  policyPermits: boolean
): ConsultResponse {
  const cappedResults = Object.freeze(
    results.map((result) =>
      Object.freeze({
        id: result.id,
        status: result.status,
        evidence: truncate(result.evidence),
      })
    )
  );
  return Object.freeze({
    verdict: foldVerdict(cappedResults, policyPermits),
    results: cappedResults,
    floorIds: Object.freeze([...floorIds]),
    advisory: true,
  });
}

// One named UNVERIFIED result, no Floor ran: shared by every early exit
// (a broken catalog, an unknown action type, a catalog with no Floor, a
// malformed or oversized input).
function singleResultResponse(
  result: ConditionResult,
  extraResults: ConditionResult[],
  policyPermits: boolean
): ConsultResponse {
  return finalizeResponse([result, ...extraResults], [], policyPermits);
}

export function unknownResponse(id: string, evidence: string): ConsultResponse {
  return singleResultResponse(
    { id, status: "UNVERIFIED", evidence },
    [],
    false
  );
}

const MAX_INPUT_JSON_LENGTH = 64 * 1024;

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
  policyInput: unknown
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
      "input-shape",
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
      {
        id: "action-type",
        status: "UNVERIFIED",
        evidence: `action type "${describe(type)}" is not in the catalog`,
      },
      extraResults,
      policyPermits
    );
  }

  const floor = conditions.filter((condition) => condition.isFloor === true);
  const floorIds = floor.map((condition) => condition.id);

  if (floorIds.length === 0) {
    return singleResultResponse(
      {
        id: "floor",
        status: "UNVERIFIED",
        evidence: "no floor for action type",
      },
      extraResults,
      policyPermits
    );
  }

  const extraIds = extraIdsRaw.filter((id) => !floorIds.includes(id));

  const results: ConditionResult[] = [
    ...floor.map((definition) => runChecker(definition, request, policy)),
    ...extraIds.map((id): ConditionResult => {
      const definition = conditions.find((condition) => condition.id === id);
      if (definition === undefined) {
        return {
          id,
          status: "UNVERIFIED",
          evidence: `condition "${describe(
            id
          )}" is not in the catalog for action type "${describe(type)}"`,
        };
      }
      return runChecker(definition, request, policy);
    }),
    ...extraResults,
  ];

  return finalizeResponse(results, floorIds, policyPermits);
}

/**
 * Binds a catalog to a `(request, policy) => ConsultResponse` function.
 * Never throws: a malformed request or policy resolves to UNKNOWN with an
 * "input-shape" result naming the defect.
 */
export function makeConsult(
  catalog: Catalog
): (request: ConsultRequest, policy: Policy) => ConsultResponse {
  return function consultBound(
    requestInput: unknown,
    policyInput: unknown
  ): ConsultResponse {
    try {
      return runConsult(catalog, requestInput, policyInput);
    } catch (error) {
      return unknownResponse("input-shape", describeInputError(error));
    }
  };
}
