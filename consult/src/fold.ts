export type ConditionStatus = "PASS" | "FAIL" | "UNVERIFIED";

export type Verdict = "ALLOW_UNDER_POLICY" | "DENY" | "UNKNOWN";

export interface ConditionResult {
  id: string;
  status: ConditionStatus;
  evidence: string;
}

// Any FAIL denies outright. Otherwise any UNVERIFIED means the request
// cannot be assessed, so the verdict stays UNKNOWN rather than guessing.
// Only a clean set of PASS results defers to the Policy.
export function foldVerdict(
  results: ConditionResult[],
  policyPermits: boolean
): Verdict {
  if (results.some((result) => result.status === "FAIL")) {
    return "DENY";
  }
  if (results.some((result) => result.status === "UNVERIFIED")) {
    return "UNKNOWN";
  }
  return policyPermits ? "ALLOW_UNDER_POLICY" : "DENY";
}
