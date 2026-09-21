import { makeConsult } from "./core";
import { PAY_CATALOG } from "./catalog";
import type { ConsultRequest, Policy } from "./catalog";
import type { ConsultResponse } from "./core";

export type { ConditionStatus, ConditionResult, Verdict } from "./fold";
export type { ConsultResponse } from "./core";
export type { ConsultAction, ConsultRequest, Policy } from "./catalog";

/**
 * The verdict core. Runs the mandatory Floor for the request's action type
 * plus any catalog-known Conditions the request adds, then folds the
 * results into one Verdict. Never mutates its inputs, never throws, and
 * never touches the network.
 *
 * The catalog is the module's own frozen catalog, not a caller argument: a
 * caller who could choose the catalog would control the verdict, so the
 * money path never takes one.
 */
export const consult: (
  request: ConsultRequest,
  policy: Policy
) => ConsultResponse = makeConsult(PAY_CATALOG);
