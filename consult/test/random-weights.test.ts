import { expect } from "chai";

import { consultWith } from "../src/internal";
import { PAY_CATALOG } from "../src/catalog";
import type { EvidenceClass } from "../src/fold";
import {
  APPROVED_RECIPIENT,
  ASSET_ADDRESS,
  UNAPPROVED_RECIPIENT,
  makePolicy,
  makeRequest,
} from "./fixtures";

// A tiny, seeded PRNG (mulberry32) so this test is deterministic without
// reaching for a dependency or Math.random.
function mulberry32(seed: number): () => number {
  let a = seed;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EVIDENCE_CLASSES: EvidenceClass[] = [
  "onchain-read",
  "owner-policy",
  "static-registry",
  "caller-stated",
  "not-verifiable",
];

function randomWeights(rand: () => number): Record<EvidenceClass, number> {
  const weights = {} as Record<EvidenceClass, number>;
  EVIDENCE_CLASSES.forEach((evidenceClass) => {
    // (0, 1]: never 0, so this table can never accidentally reproduce the
    // real "not-verifiable" weight of 0 by chance alone.
    weights[evidenceClass] = rand() * 0.999 + 0.001;
  });
  return weights;
}

// Requests exercising every shape of outcome consult() can reach: a clean
// ALLOW, a DENY, an UNKNOWN-with-floor (permits false), and an UNKNOWN with
// no floor at all (an unknown action type).
function randomRequestAndPolicy(rand: () => number): [unknown, unknown] {
  const roll = rand();
  const base = makeRequest();
  if (roll < 0.25) {
    return [base, makePolicy()];
  }
  if (roll < 0.5) {
    return [
      { ...base, action: { ...base.action, recipient: UNAPPROVED_RECIPIENT } },
      makePolicy(),
    ];
  }
  if (roll < 0.75) {
    return [base, makePolicy({ permits: false })];
  }
  return [{ ...base, action: { ...base.action, type: "swap" } }, makePolicy()];
}

describe("evidence-class weights cannot move the verdict", () => {
  it("verdict and proceed are identical across a few hundred requests, whatever the weight table says", () => {
    const rand = mulberry32(42);
    const realConsult = consultWith(PAY_CATALOG);

    let checked = 0;
    for (let i = 0; i < 300; i += 1) {
      const [request, policy] = randomRequestAndPolicy(rand);
      const weights = randomWeights(rand);
      const withRandomWeights = consultWith(PAY_CATALOG, weights);

      const real = realConsult(request as never, policy as never);
      const random = withRandomWeights(request as never, policy as never);

      expect(random.verdict, `case ${i}`).to.equal(real.verdict);
      expect(random.proceed, `case ${i}`).to.equal(real.proceed);
      checked += 1;
    }
    expect(checked).to.equal(300);
  });

  it("sanity: a clean request still earns ALLOW under a substituted weight table", () => {
    const weights: Record<EvidenceClass, number> = {
      "onchain-read": 0.5,
      "owner-policy": 0.5,
      "static-registry": 0.5,
      "caller-stated": 0.5,
      "not-verifiable": 0.5,
    };
    const response = consultWith(PAY_CATALOG, weights)(
      makeRequest(),
      makePolicy()
    );
    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(response.proceed).to.equal(true);
    // The weight table only ever moves `support`, never the verdict it is
    // computed from.
    expect(response.support).to.equal(0.9);
  });

  it("never uses the address fixture as its own registry entry by accident", () => {
    // Guards the fixture itself: if ASSET_ADDRESS and APPROVED_RECIPIENT
    // were ever the same string, several of the assertions above would
    // pass for the wrong reason.
    expect(ASSET_ADDRESS.toLowerCase()).to.not.equal(
      APPROVED_RECIPIENT.toLowerCase()
    );
  });
});
