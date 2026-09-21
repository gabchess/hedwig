import { foldVerdict, type ConditionResult, type Verdict } from "./fold";
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

function runChecker(
  definition: ConditionDefinition,
  request: ConsultRequest,
  policy: Policy
): ConditionResult {
  try {
    return definition.check(request, { policy });
  } catch (error) {
    // A checker that throws is never a crash of consult and never a PASS.
    return {
      id: definition.id,
      status: "UNVERIFIED",
      evidence:
        error instanceof Error ? error.constructor.name : "unknown error",
    };
  }
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
  const conditions = catalog[request.action.type];

  if (conditions === undefined) {
    const result: ConditionResult = {
      id: "action-type",
      status: "UNVERIFIED",
      evidence: `action type "${request.action.type}" is not in the catalog`,
    };
    return {
      verdict: foldVerdict([result], policy.permits),
      results: [result],
      floorIds: [],
      advisory: true,
    };
  }

  const floor = conditions.filter((condition) => condition.isFloor);
  const floorIds = floor.map((condition) => condition.id);
  const extraIds = (request.conditions ?? []).filter(
    (id) => !floorIds.includes(id)
  );

  const results: ConditionResult[] = [
    ...floor.map((definition) => runChecker(definition, request, policy)),
    ...extraIds.map((id): ConditionResult => {
      const definition = conditions.find((condition) => condition.id === id);
      if (definition === undefined) {
        return {
          id,
          status: "UNVERIFIED",
          evidence: `condition "${id}" is not in the catalog for action type "${request.action.type}"`,
        };
      }
      return runChecker(definition, request, policy);
    }),
  ];

  return {
    verdict: foldVerdict(results, policy.permits),
    results,
    floorIds,
    advisory: true,
  };
}
