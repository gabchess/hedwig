import { expect } from "chai";

import { PAY_CATALOG, validateCatalog } from "../src/catalog";
import type { Catalog } from "../src/catalog";
import type { EvidenceClass } from "../src/fold";
import { consultWith } from "../src/internal";
import {
  APPROVED_RECIPIENT,
  makePolicy,
  makeRequest,
  testCondition,
} from "./fixtures";

type Weights = Record<EvidenceClass, number>;

function weightsOf(value: number): Weights {
  return {
    "onchain-read": value,
    "owner-policy": value,
    "static-registry": value,
    "not-verifiable": value,
  };
}

// Weight tables no sane caller would pass: each one used to push `support`
// out of range or across the green edge.
const HOSTILE_WEIGHTS: Array<[string, Weights]> = [
  ["five", weightsOf(5)],
  ["just over one", weightsOf(1.02)],
  ["negative", weightsOf(-1)],
  ["tiny negative", weightsOf(-0.0001)],
  ["NaN", weightsOf(Number.NaN)],
  ["Infinity", weightsOf(Number.POSITIVE_INFINITY)],
  ["missing keys", {} as Weights],
  ["strings", weightsOf("1" as unknown as number)],
];

const REQUESTS: Array<[string, unknown, unknown]> = [
  ["clean allow", makeRequest(), makePolicy()],
  ["policy does not permit", makeRequest(), makePolicy({ permits: false })],
  [
    "one unverified row",
    { action: { ...makeRequest().action, target: "x" } },
    makePolicy({ permits: false }),
  ],
  [
    "one failing row",
    { action: { ...makeRequest().action, amount: "1000001" } },
    makePolicy(),
  ],
  [
    "unknown action type",
    { action: { ...makeRequest().action, type: "swap" } },
    makePolicy(),
  ],
];

describe("support stays in range whatever the weight table says", () => {
  const real = consultWith(PAY_CATALOG);

  HOSTILE_WEIGHTS.forEach(([weightName, weights]) => {
    REQUESTS.forEach(([requestName, request, policy]) => {
      it(`${weightName} weights, ${requestName}`, () => {
        const expected = real(request as never, policy as never);
        const response = consultWith(PAY_CATALOG, weights)(
          request as never,
          policy as never
        );

        expect(response.verdict).to.equal(expected.verdict);
        expect(response.proceed).to.equal(expected.proceed);
        expect(response.proceed).to.equal(
          response.verdict === "ALLOW_UNDER_POLICY"
        );
        expect(Number.isFinite(response.support)).to.equal(true);
        expect(Object.is(response.support, -0)).to.equal(false);
        expect(response.support).to.be.within(0, 1);
        expect(response.support >= 0.8).to.equal(response.proceed);
        expect(response.band === "green").to.equal(response.proceed);
      });
    });
  });
});

describe("a checker cannot choose its own evidence class", () => {
  it("the catalog's class for the returned code is the one reported", () => {
    const catalog: Catalog = {
      pay: [
        ...PAY_CATALOG.pay,
        testCondition({
          id: "inflated",
          isFloor: false,
          check: () => ({
            id: "inflated",
            status: "PASS",
            code: "TEST_PASS",
            evidenceClass: "onchain-read",
            evidence: "claims a stronger proof than the catalog declares",
          }),
        }),
      ],
    };
    const response = consultWith(catalog)(
      makeRequest({ conditions: ["inflated"] }),
      makePolicy()
    );
    const row = response.results.find((result) => result.id === "inflated");

    expect(row?.status).to.equal("PASS");
    expect(row?.evidenceClass).to.equal("owner-policy");
  });

  it("a code the Condition never declared is a malformed result", () => {
    const catalog: Catalog = {
      pay: [
        ...PAY_CATALOG.pay,
        testCondition({
          id: "undeclared",
          isFloor: true,
          check: () => ({
            id: "undeclared",
            status: "PASS",
            code: "RECIPIENT_MATCHES_POLICY",
            evidenceClass: "owner-policy",
            evidence: "borrows another Condition's code",
          }),
        }),
      ],
    };
    const response = consultWith(catalog)(makeRequest(), makePolicy());
    const row = response.results.find((result) => result.id === "undeclared");

    expect(row?.status).to.equal("UNVERIFIED");
    expect(row?.code).to.equal("RESULT_MALFORMED");
    expect(response.proceed).to.equal(false);
  });
});

describe("the catalog cannot redefine the core's own codes", () => {
  [
    "RESULT_MALFORMED",
    "CHECKER_THREW",
    "INPUT_SHAPE_INVALID",
    "INPUT_TOO_LARGE",
    "ACTION_TYPE_UNKNOWN",
    "CONDITION_UNKNOWN",
    "FLOOR_MISSING",
  ].forEach((coreCode) => {
    it(`rejects a Condition that declares ${coreCode}`, () => {
      const catalog: Catalog = {
        pay: [
          testCondition({
            id: "reuses-core-code",
            isFloor: true,
            codes: {
              pass: coreCode,
              fail: ["TEST_FAIL"],
              unverified: ["TEST_UNVERIFIED"],
            },
            codeEvidenceClass: {
              [coreCode]: "owner-policy",
              TEST_FAIL: "owner-policy",
              TEST_UNVERIFIED: "not-verifiable",
            },
            check: () => ({
              id: "reuses-core-code",
              status: "PASS",
              code: coreCode,
              evidenceClass: "owner-policy",
              evidence: "n/a",
            }),
          }),
        ],
      };
      expect(validateCatalog(catalog)).to.be.a("string");
    });
  });
});

describe("a catalog changed after it is bound", () => {
  it("does not change what the bound function checks", () => {
    const conditions = [...PAY_CATALOG.pay];
    const catalog = { pay: conditions };
    const bound = consultWith(catalog);

    // Drop every Floor Condition but one, after binding.
    conditions.splice(1);

    const response = bound(
      { action: { ...makeRequest().action, amount: "9999999999" } },
      makePolicy()
    );
    expect(response.proceed).to.equal(false);
    expect(response.floorIds).to.have.length(PAY_CATALOG.pay.length);
  });
});

describe("the contract a payment calls", () => {
  it("is not the recipient", () => {
    const response = consultWith(PAY_CATALOG)(
      { action: { ...makeRequest().action, target: APPROVED_RECIPIENT } },
      makePolicy()
    );
    const row = response.results.find(
      (result) => result.id === "target-is-canonical"
    );

    expect(row?.status).to.equal("FAIL");
    expect(response.verdict).to.equal("DENY");
    expect(response.support).to.equal(0);
  });
});

describe("abstention wording", () => {
  it("is applied unless the evidence already opens with the exact words", () => {
    const catalog: Catalog = {
      pay: [
        ...PAY_CATALOG.pay,
        testCondition({
          id: "shouty",
          isFloor: false,
          check: () => ({
            id: "shouty",
            status: "UNVERIFIED",
            code: "TEST_UNVERIFIED",
            evidenceClass: "not-verifiable",
            evidence: "CANNOT CONFIRMED lol",
          }),
        }),
      ],
    };
    const response = consultWith(catalog)(
      makeRequest({ conditions: ["shouty"] }),
      makePolicy()
    );
    const row = response.results.find((result) => result.id === "shouty");

    expect(row?.evidence.startsWith("cannot confirm: ")).to.equal(true);
  });
});
