import { expect } from "chai";

import {
  BAND_GREEN_MIN,
  BAND_RED_MAX,
  EVIDENCE_CLASS_WEIGHTS,
} from "../src/constants";
import { bandOf, supportOf } from "../src/support";
import type { SupportEntry } from "../src/support";

// The six pay Floor Conditions once target-is-canonical exists: three
// owner-policy (0.9) and three static-registry (0.6), so the weakest PASS
// weight in a clean pay request is 0.6.
const CLEAN_PAY_RESULTS: SupportEntry[] = [
  { status: "PASS", evidenceClass: "owner-policy" },
  { status: "PASS", evidenceClass: "static-registry" },
  { status: "PASS", evidenceClass: "static-registry" },
  { status: "PASS", evidenceClass: "owner-policy" },
  { status: "PASS", evidenceClass: "owner-policy" },
  { status: "PASS", evidenceClass: "static-registry" },
];

describe("supportOf", () => {
  it("is 0 for DENY, whatever the results say", () => {
    expect(supportOf("DENY", CLEAN_PAY_RESULTS, true)).to.equal(0);
    expect(supportOf("DENY", [], true)).to.equal(0);
  });

  it("is 0 when no Floor ran, even for an UNKNOWN with a lone PASS-shaped row", () => {
    expect(
      supportOf(
        "UNKNOWN",
        [{ status: "UNVERIFIED", evidenceClass: "not-verifiable" }],
        false
      )
    ).to.equal(0);
  });

  it("pins the worked ALLOW value: 0.80 + 0.20 x the weakest PASS weight (0.6) = 0.92", () => {
    expect(supportOf("ALLOW_UNDER_POLICY", CLEAN_PAY_RESULTS, true)).to.equal(
      0.92
    );
  });

  it("pins the worked UNKNOWN-with-floor value: 0.79 x the weighted PASS share", () => {
    // Same six rows, all PASS, but the verdict is UNKNOWN (policy.permits was
    // not strictly true): s = (0.9*3 + 0.6*3) / 6 = 0.75, support = 0.79*0.75.
    expect(supportOf("UNKNOWN", CLEAN_PAY_RESULTS, true)).to.equal(0.59);
  });

  it("an UNKNOWN-with-floor support can never reach the green threshold, even at s = 1", () => {
    const allWeight1: SupportEntry[] = [
      { status: "PASS", evidenceClass: "onchain-read" },
    ];
    const support = supportOf("UNKNOWN", allWeight1, true);
    expect(support).to.equal(0.79);
    expect(support).to.be.lessThan(BAND_GREEN_MIN);
  });

  it("rounds to two decimals", () => {
    const oneThird: SupportEntry[] = [
      { status: "PASS", evidenceClass: "owner-policy" },
      { status: "UNVERIFIED", evidenceClass: "not-verifiable" },
      { status: "UNVERIFIED", evidenceClass: "not-verifiable" },
    ];
    const support = supportOf("UNKNOWN", oneThird, true);
    expect(Number.isInteger(support * 100)).to.equal(true);
  });

  it("accepts an injected weight table without importing it from anywhere but its own parameter", () => {
    const doubled = Object.fromEntries(
      Object.entries(EVIDENCE_CLASS_WEIGHTS).map(([key, value]) => [
        key,
        Math.min(1, value * 2),
      ])
    ) as Record<string, number>;
    const supportWithRealWeights = supportOf(
      "ALLOW_UNDER_POLICY",
      CLEAN_PAY_RESULTS,
      true
    );
    const supportWithDoubledWeights = supportOf(
      "ALLOW_UNDER_POLICY",
      CLEAN_PAY_RESULTS,
      true,
      doubled as never
    );
    // static-registry (0.6) doubles to 1.2, capped at 1: the weakest weight
    // among the PASS rows changes, so the resulting support changes too.
    expect(supportWithDoubledWeights).to.not.equal(supportWithRealWeights);
  });
});

describe("bandOf", () => {
  it("is green at and above the green threshold", () => {
    expect(bandOf(BAND_GREEN_MIN)).to.equal("green");
    expect(bandOf(1)).to.equal("green");
  });

  it("is red below the red threshold", () => {
    expect(bandOf(0)).to.equal("red");
    expect(bandOf(BAND_RED_MAX - 0.01)).to.equal("red");
  });

  it("is amber in between, inclusive of the red threshold", () => {
    expect(bandOf(BAND_RED_MAX)).to.equal("amber");
    expect(bandOf(BAND_GREEN_MIN - 0.01)).to.equal("amber");
  });
});
