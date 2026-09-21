import type { ConditionStatus, EvidenceClass } from "./fold";

export type { EvidenceClass } from "./fold";

export type Band = "green" | "amber" | "red";

// The full per-Condition report carried in a ConsultResponse. question and
// reference are fixed catalog text, never built from request text.
// evidenceClass is derived by the core from the catalog's own
// code -> evidenceClass table, never trusted from the checker directly.
export interface ConditionResult {
  readonly id: string;
  readonly question: string;
  readonly status: ConditionStatus;
  readonly code: string;
  readonly evidence: string;
  readonly evidenceClass: EvidenceClass;
  readonly reference: string;
}
