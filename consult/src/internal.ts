// consult() binds the catalog to protect the money path: a caller who could
// choose the catalog would control the verdict. consultWith exists only so
// tests can exercise a custom or deliberately broken catalog, or a
// substituted evidence-class weight table; index.ts, the package door,
// never re-exports this file.
import { validateCatalog } from "./catalog";
import { makeConsult, unknownResponse } from "./core";
import type { Catalog, ConsultRequest, Policy } from "./catalog";
import type { ConsultResponse } from "./core";
import type { EvidenceClass } from "./fold";

export function consultWith(
  catalog: Catalog,
  weights?: Readonly<Record<EvidenceClass, number>>
): (request: ConsultRequest, policy: Policy) => ConsultResponse {
  const defect = validateCatalog(catalog);
  if (defect !== undefined) {
    return () => unknownResponse("INPUT_SHAPE_INVALID", defect);
  }
  return makeConsult(catalog, weights);
}
