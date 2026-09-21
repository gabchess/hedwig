// The number is computed AFTER the verdict, never before and never instead
// of it: `verdict` is a required input here, so a caller cannot even call
// this function until foldVerdict has already run. Nothing in this file
// feeds back into fold.ts; fold.ts does not import this file, or know it
// exists.
import {
  ALLOW_SUPPORT_SPAN,
  BAND_GREEN_MIN,
  BAND_RED_MAX,
  EVIDENCE_CLASS_WEIGHTS,
  UNKNOWN_WITH_FLOOR_FACTOR,
} from "./constants";
import type { Verdict } from "./fold";
import type { Band, EvidenceClass } from "./types";

export interface SupportEntry {
  readonly status: "PASS" | "FAIL" | "UNVERIFIED";
  readonly evidenceClass: EvidenceClass;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Scores how much of the owner's checklist was proven and how strong the
 * proof was. This score can never decide `verdict`: it is a pure function
 * OF the already-decided verdict and the results that produced it.
 *
 * - DENY, or no Floor ran at all: 0.
 * - ALLOW_UNDER_POLICY: 0.80 plus up to 0.20 more, scaled by the weakest
 *   evidence-class weight among the PASS rows (as strong as the weakest
 *   proof).
 * - UNKNOWN with a Floor that did run: 0.79 times the weighted share of
 *   rows that passed, so it can never reach the green threshold (0.79 is
 *   below 0.80 even when every row passed).
 */
export function supportOf(
  verdict: Verdict,
  results: readonly SupportEntry[],
  floorRan: boolean,
  weights: Readonly<Record<EvidenceClass, number>> = EVIDENCE_CLASS_WEIGHTS
): number {
  if (verdict === "DENY" || !floorRan) {
    return 0;
  }

  const passWeights = results
    .filter((result) => result.status === "PASS")
    .map((result) => weights[result.evidenceClass]);

  if (verdict === "ALLOW_UNDER_POLICY") {
    const weakest = passWeights.length > 0 ? Math.min(...passWeights) : 0;
    return round2(BAND_GREEN_MIN + ALLOW_SUPPORT_SPAN * weakest);
  }

  // UNKNOWN with a Floor: the weighted share of PASS rows, scaled down.
  if (results.length === 0) {
    return 0;
  }
  const passWeightSum = passWeights.reduce((sum, weight) => sum + weight, 0);
  const share = passWeightSum / results.length;
  return round2(UNKNOWN_WITH_FLOOR_FACTOR * share);
}

export function bandOf(support: number): Band {
  if (support >= BAND_GREEN_MIN) return "green";
  if (support < BAND_RED_MAX) return "red";
  return "amber";
}
