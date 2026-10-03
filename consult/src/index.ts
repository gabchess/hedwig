import { makeConsult } from "./core";
import { CATALOG } from "./catalog";
import type { ConsultRequest, Policy } from "./catalog";
import type { ConsultResponse } from "./core";

export type { ConditionStatus, Verdict } from "./fold";
export type { ConsultResponse } from "./core";
export type { Band, ConditionResult, EvidenceClass } from "./types";
export type {
  ConsultAction,
  ConsultRequest,
  Facts,
  Policy,
  RegistryAssetFact,
  RegistryLiveRead,
} from "./catalog";

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
 * `facts` is the optional third argument and carries observations as data:
 * `now`, a unix-seconds timestamp, `solanaRole`, a role fact, and
 * `registryAsset`, a registry row for a token the code table does not list,
 * passed only after the caller's Reader checked its signatures (consult
 * checks none). The code table always wins; a registry row only fills a gap,
 * is ignored once expired or without `now` or `liveReadAt`, and proves a
 * token only at the row's own address while its live read is `confirmed`
 * and no older than 60 seconds. A different address is FAIL whatever the
 * live read says. consult() never reads a clock or a chain itself.
 * `facts.params` carries the service's constants. The core takes it out of
 * `facts` before any Condition runs, and a Condition reads one listed,
 * check or both constant through `context.param`. Facts
 * that are missing, malformed,
 * uncloneable or over the size limit count as no facts: the Condition that
 * needs them answers UNVERIFIED. A `pay` under a policy that requires no
 * role reads no fact at all.
 */
export const consult: (
  request: ConsultRequest,
  policy: Policy,
  facts?: unknown
) => ConsultResponse = makeConsult(CATALOG);
