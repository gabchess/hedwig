// consult() binds the catalog to protect the money path: a caller who could
// choose the catalog would control the verdict. consultWith exists only so
// tests can exercise a custom or deliberately broken catalog, or a
// substituted evidence-class weight table; index.ts, the package door,
// never re-exports this file.
import { validateCatalog } from "./catalog";
import { makeConsult, unknownResponse } from "./core";
import type {
  Catalog,
  ConditionDefinition,
  ConsultRequest,
  Policy,
} from "./catalog";
import type { ConsultResponse } from "./core";
import type { EvidenceClass } from "./fold";

export function consultWith(
  catalog: Catalog,
  weights?: Readonly<Record<EvidenceClass, number>>
): (
  request: ConsultRequest,
  policy: Policy,
  facts?: unknown
) => ConsultResponse {
  const defect = validateCatalog(catalog);
  if (defect !== undefined) {
    return () => unknownResponse("INPUT_SHAPE_INVALID", defect);
  }
  // Bound by value: the validated Conditions are the ones that run, whatever
  // the caller does to its own catalog object afterwards.
  const bound: Record<string, readonly ConditionDefinition[]> = {};
  for (const [actionType, conditions] of Object.entries(catalog)) {
    bound[actionType] = Object.freeze(
      conditions.map((condition) =>
        Object.freeze({
          ...condition,
          codes: Object.freeze({
            pass: condition.codes.pass,
            fail: Object.freeze([...condition.codes.fail]),
            unverified: Object.freeze([...condition.codes.unverified]),
          }),
          codeEvidenceClass: Object.freeze({ ...condition.codeEvidenceClass }),
        })
      )
    );
  }
  return makeConsult(Object.freeze(bound), weights);
}
