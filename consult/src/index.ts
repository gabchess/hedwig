import {
  foldVerdict,
  type ConditionResult,
  type ConditionStatus,
  type Verdict,
} from "./fold";
import { deepFreeze, describe } from "./catalog";
import type {
  Catalog,
  ConditionDefinition,
  ConsultRequest,
  Policy,
} from "./catalog";

export type { ConditionStatus, ConditionResult, Verdict } from "./fold";
export type {
  Catalog,
  ConditionChecker,
  ConditionContext,
  ConditionDefinition,
  ConsultAction,
  ConsultRequest,
  Policy,
} from "./catalog";
export { PAY_CATALOG } from "./catalog";

export interface ConsultResponse {
  verdict: Verdict;
  results: ConditionResult[];
  floorIds: string[];
  advisory: true;
}

const VALID_STATUSES: ConditionStatus[] = ["PASS", "FAIL", "UNVERIFIED"];

function isPlainResult(value: unknown): value is ConditionResult {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).id === "string" &&
    typeof (value as Record<string, unknown>).status === "string" &&
    typeof (value as Record<string, unknown>).evidence === "string"
  );
}

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

// A checker is a black box: its return value is data from an untrusted
// caller-supplied function, not a trusted internal type. Every shape other
// than an exact { id, status, evidence } for THIS definition's id, with a
// recognised status, resolves to UNVERIFIED rather than crashing consult or
// silently passing through.
function runChecker(
  definition: ConditionDefinition,
  request: ConsultRequest,
  policy: Policy
): ConditionResult {
  let outcome: unknown;
  try {
    outcome = definition.check(request, { policy });
  } catch (error) {
    // A checker that throws is never a crash of consult and never a PASS.
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
  if (!isPlainResult(outcome)) {
    return {
      id: definition.id,
      status: "UNVERIFIED",
      evidence: "checker returned a malformed result",
    };
  }
  if (outcome.id !== definition.id) {
    return {
      id: definition.id,
      status: "UNVERIFIED",
      evidence: `checker returned id "${describe(outcome.id)}" instead of "${
        definition.id
      }"`,
    };
  }
  if (!VALID_STATUSES.includes(outcome.status as ConditionStatus)) {
    return {
      id: definition.id,
      status: "UNVERIFIED",
      evidence: `checker returned an unrecognised status "${describe(
        outcome.status
      )}"`,
    };
  }
  return outcome;
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
  if (
    Array.isArray(conditions) &&
    conditions.every((id) => typeof id === "string")
  ) {
    // Dedupe: a repeated id must not run its checker twice.
    return { ids: [...new Set(conditions)] };
  }
  return {
    ids: [],
    extraResult: {
      id: "input-shape",
      status: "UNVERIFIED",
      evidence: "conditions must be an array of strings",
    },
  };
}

// Both early exits below share this shape: one named UNVERIFIED result (plus
// any input-shape complaint), no Floor ran, folded the same way as a full run.
function unverifiedTerminal(
  id: string,
  evidence: string,
  extraResults: ConditionResult[],
  policy: Policy
): ConsultResponse {
  const results = [
    { id, status: "UNVERIFIED" as const, evidence },
    ...extraResults,
  ];
  return {
    verdict: foldVerdict(results, policy.permits === true),
    results,
    floorIds: [],
    advisory: true,
  };
}

function runConsult(
  requestInput: unknown,
  catalogInput: unknown,
  policyInput: unknown
): ConsultResponse {
  const requestObj = requireObject(requestInput, "request");
  const actionObj = requireObject(requestObj.action, "request.action");
  requireObject(catalogInput, "catalog");
  const policyObj = requireObject(policyInput, "policy");

  // Deep-frozen structured clones: a checker can read request and policy,
  // but cannot mutate them to poison a later Floor check in the same call.
  const request = deepFreeze(
    structuredClone(requestObj)
  ) as unknown as ConsultRequest;
  const policy = deepFreeze(structuredClone(policyObj)) as unknown as Policy;
  const catalog = catalogInput as Catalog;

  const { ids: extraIdsRaw, extraResult } = readConditionIds(requestObj);
  const extraResults = extraResult ? [extraResult] : [];

  const type = actionObj.type;
  const conditions =
    typeof type === "string" &&
    Object.hasOwn(catalog, type) &&
    Array.isArray((catalog as Record<string, unknown>)[type])
      ? (catalog as Record<string, ConditionDefinition[]>)[type]
      : undefined;

  if (conditions === undefined) {
    return unverifiedTerminal(
      "action-type",
      `action type "${describe(type)}" is not in the catalog`,
      extraResults,
      policy
    );
  }

  const floor = conditions.filter((condition) => condition.isFloor === true);
  const floorIds = floor.map((condition) => condition.id);

  if (floorIds.length === 0) {
    return unverifiedTerminal(
      "floor",
      "no floor for action type",
      extraResults,
      policy
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

  return {
    verdict: foldVerdict(results, policy.permits === true),
    results,
    floorIds,
    advisory: true,
  };
}

/**
 * The verdict core. Runs the mandatory Floor for the request's action type
 * plus any catalog-known Conditions the request adds, then folds the
 * results into one Verdict. Never mutates its inputs, never throws, and
 * never touches the network.
 */
export function consult(
  request: ConsultRequest,
  catalog: Catalog,
  policy: Policy
): ConsultResponse {
  try {
    return runConsult(request, catalog, policy);
  } catch (error) {
    return {
      verdict: "UNKNOWN",
      results: [
        {
          id: "input-shape",
          status: "UNVERIFIED",
          evidence: describeInputError(error),
        },
      ],
      floorIds: [],
      advisory: true,
    };
  }
}
