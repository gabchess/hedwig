export type ConditionStatus = "PASS" | "FAIL" | "UNVERIFIED";

export type Verdict = "ALLOW_UNDER_POLICY" | "DENY" | "UNKNOWN";

// How strong the proof behind a status is, strongest to weakest.
// "not-verifiable" is what a Condition that could not run at all reports; it
// is never a legitimate reason a PASS stands on.
export type EvidenceClass =
  | "onchain-read"
  | "owner-policy"
  | "static-registry"
  | "not-verifiable";

// What a Condition's checker returns, and the only shape foldVerdict reads
// (and it reads only .status). This module owns verdict logic and nothing
// else: `code` and `evidenceClass` ride along for a downstream module to
// score after the fact, and this module has no dependency on that module,
// so it cannot be tempted to let a number influence a decision that must be
// earned by checks alone.
export interface CheckerOutcome {
  id: string;
  status: ConditionStatus;
  code: string;
  evidence: string;
  evidenceClass: EvidenceClass;
}

// ALLOW is the only verdict that must be earned: it requires a non-empty,
// all-PASS result set AND a Policy that permits. A FAIL anywhere denies
// outright, and everything else (no results, a mix, an UNVERIFIED, a Policy
// that does not permit) resolves to UNKNOWN rather than guessing.
export function foldVerdict(
  results: readonly CheckerOutcome[],
  policyPermits: boolean
): Verdict {
  if (results.some((result) => result.status === "FAIL")) {
    return "DENY";
  }
  if (
    results.length > 0 &&
    results.every((result) => result.status === "PASS") &&
    policyPermits
  ) {
    return "ALLOW_UNDER_POLICY";
  }
  return "UNKNOWN";
}
