import { expect } from "chai";

import { consult } from "../src";
import { consultWith } from "../src/internal";
import { PAY_CATALOG } from "../src/catalog";
import type { Catalog } from "../src/catalog";
import { makePolicy, makeRequest } from "./fixtures";

function expectEveryUnverifiedAbstains(
  response: ReturnType<typeof consult>
): void {
  const unverified = response.results.filter((r) => r.status === "UNVERIFIED");
  expect(
    unverified.length,
    "expected at least one UNVERIFIED row"
  ).to.be.greaterThan(0);
  unverified.forEach((result) => {
    expect(result.evidence, result.id).to.match(/^cannot confirm/);
  });
}

describe("abstention wording", () => {
  it("a Condition-level UNVERIFIED (bad recipient shape) abstains with the fixed words", () => {
    const response = consult(
      makeRequest({
        action: { ...makeRequest().action, recipient: "not-an-address" },
      }),
      makePolicy()
    );
    expectEveryUnverifiedAbstains(response);
  });

  it("a core-level UNVERIFIED (unknown action type) abstains with the fixed words", () => {
    const response = consult(
      makeRequest({ action: { ...makeRequest().action, type: "swap" } }),
      makePolicy()
    );
    expectEveryUnverifiedAbstains(response);
  });

  it("a core-level UNVERIFIED (unknown extra condition id) abstains with the fixed words", () => {
    const response = consult(
      { ...makeRequest(), conditions: ["not-a-real-condition"] },
      makePolicy()
    );
    expectEveryUnverifiedAbstains(response);
  });

  it("a malformed-result UNVERIFIED (checker threw) abstains with the fixed words", () => {
    const catalog: Catalog = {
      pay: [
        ...PAY_CATALOG.pay,
        {
          id: "throws",
          isFloor: false,
          question: "Does this ever pass?",
          reference: "consult/references/core.md",
          codes: {
            pass: "THROWS_PASS",
            fail: ["THROWS_FAIL"],
            unverified: ["THROWS_UNVERIFIED"],
          },
          codeEvidenceClass: {
            THROWS_PASS: "owner-policy",
            THROWS_FAIL: "owner-policy",
            THROWS_UNVERIFIED: "not-verifiable",
          },
          check: () => {
            throw new Error("boom");
          },
        },
      ],
    };
    const response = consultWith(catalog)(
      { ...makeRequest(), conditions: ["throws"] },
      makePolicy()
    );
    expectEveryUnverifiedAbstains(response);
  });

  it("does not double the prefix when a checker's own evidence already starts with it", () => {
    const catalog: Catalog = {
      pay: [
        {
          id: "already-abstains",
          isFloor: true,
          question: "Does this ever pass?",
          reference: "consult/references/core.md",
          codes: {
            pass: "AA_PASS",
            fail: ["AA_FAIL"],
            unverified: ["AA_UNVERIFIED"],
          },
          codeEvidenceClass: {
            AA_PASS: "owner-policy",
            AA_FAIL: "owner-policy",
            AA_UNVERIFIED: "not-verifiable",
          },
          check: () => ({
            id: "already-abstains",
            status: "UNVERIFIED",
            code: "AA_UNVERIFIED",
            evidenceClass: "not-verifiable",
            evidence: "cannot confirm: already phrased this way",
          }),
        },
      ],
    };
    const response = consultWith(catalog)(makeRequest(), makePolicy());
    const result = response.results.find((r) => r.id === "already-abstains");
    expect(result?.evidence).to.equal(
      "cannot confirm: already phrased this way"
    );
  });
});
