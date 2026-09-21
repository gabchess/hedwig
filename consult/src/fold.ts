export type ConditionStatus = "PASS" | "FAIL" | "UNVERIFIED";

export type Verdict = "ALLOW_UNDER_POLICY" | "DENY" | "UNKNOWN";

export interface ConditionResult {
  id: string;
  status: ConditionStatus;
  evidence: string;
}

// ALLOW is the only verdict that must be earned: it requires a non-empty,
// all-PASS result set AND a Policy that permits. A FAIL anywhere denies
// outright, and everything else (no results, a mix, an UNVERIFIED, a Policy
// that does not permit) resolves to UNKNOWN rather than guessing.
export function foldVerdict(
  results: readonly ConditionResult[],
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
