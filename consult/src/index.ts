import { makeConsult } from "./core";
import { CATALOG } from "./catalog";
import type { ConsultRequest, Policy } from "./catalog";
import type { ConsultResponse } from "./core";

export type { ConditionStatus, Verdict } from "./fold";
export type { ConsultResponse } from "./core";
export type { Band, ConditionResult, EvidenceClass } from "./types";
export type { ConsultAction, ConsultRequest, Policy } from "./catalog";

/**
 * The verdict core. Runs the mandatory Floor for the request's action type
 * plus any catalog-known Conditions the request adds, then folds the
 * results into one Verdict. Never mutates its inputs, never throws, and
 * never touches the network.
 *
 * Invariants:
 * - Checks decide. Every Verdict comes from the Conditions' PASS/FAIL/
 *   UNVERIFIED statuses and the Policy alone.
 * - The number is computed after the Verdict. `support` and `band` are a
 *   pure function OF the already-decided `verdict` and `results`; neither
 *   can move a Verdict, and `fold.ts` (the Verdict logic) does not import
 *   the module that computes them.
 * - Anything that tightens toward DENY never depends on an optional layer:
 *   a FAIL anywhere denies outright, whatever else did or did not run.
 * - Act on `proceed`. It is exactly `verdict === "ALLOW_UNDER_POLICY"`; the
 *   support score and band are context for a human, never a second gate.
 *
 * The catalog is the module's own frozen catalog, not a caller argument: a
 * caller who could choose the catalog would control the verdict, so the
 * money path never takes one.
 *
 * `facts` is optional, third-argument time-as-data (currently just
 * `now`, a unix-seconds timestamp): consult() never reads a clock itself,
 * and a missing or malformed `facts` never throws, it only leaves whatever
 * Condition needs it UNVERIFIED. `pay` reads no fact at all.
 */
export const consult: (
  request: ConsultRequest,
  policy: Policy,
  facts?: unknown
) => ConsultResponse = makeConsult(CATALOG);
