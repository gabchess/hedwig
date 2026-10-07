import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import { consult } from "../src";
import { consultWith } from "../src/internal";
import { PAY_CATALOG } from "../src/catalog";
import type {
  Catalog,
  ConditionDefinition,
  ConsultRequest,
  Policy,
} from "../src/catalog";
import {
  APPROVED_RECIPIENT,
  makePolicy,
  makeRequest,
  testCondition,
} from "./fixtures";

interface CorpusEntry {
  id: string;
  authorizedAllow: boolean;
  request: unknown;
  policy: unknown;
  // Optional: entries that need a clock or a role fact carry this.
  facts?: unknown;
}

const CORPUS: CorpusEntry[] = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "wrong-proceed-corpus.json"), "utf8")
);

// Every input that once earned a wrong proceed, in one place: no entry may
// resolve to proceed:true or support >= 0.80 unless the corpus itself
// marks it an authorised allow. Adding a new hole to this file, without
// marking it authorised, is enough to make CI catch a future regression.
describe("wrong-proceed corpus", () => {
  it("plain-JSON adversarial requests never earn an unauthorised allow", () => {
    expect(CORPUS.length).to.be.greaterThan(5);
    // Bound direct transfers retain two authorised allows: optional role,
    // and required role with a good fact. Unbound swaps must refuse.
    expect(CORPUS.filter((entry) => entry.authorizedAllow).length).to.equal(2);
    CORPUS.forEach((entry) => {
      const response = consult(
        entry.request as never,
        entry.policy as never,
        entry.facts as never
      );
      if (entry.authorizedAllow) {
        expect(response.proceed, entry.id).to.equal(true);
        expect(response.support, entry.id).to.be.at.least(0.8);
      } else {
        expect(response.proceed, entry.id).to.equal(false);
        expect(response.support, entry.id).to.be.lessThan(0.8);
      }
    });
  });

  // Preserve each authorization refusal. Required EIP-3009 also fails
  // call binding because a direct ERC-20 transfer cannot satisfy it.
  const AUTHORIZATION_WINDOW_SINGLE_CAUSE: Record<string, string> = {
    "pay-authorization-window-policy-missing": "AUTHORIZATION_POLICY_MISSING",
    "pay-authorization-window-policy-malformed":
      "AUTHORIZATION_POLICY_MALFORMED",
    "pay-authorization-window-ceiling-missing": "AUTHORIZATION_CEILING_MISSING",
    "pay-authorization-window-ceiling-malformed":
      "AUTHORIZATION_CEILING_MALFORMED",
    "pay-authorization-malformed": "AUTHORIZATION_MALFORMED",
    "pay-authorization-now-unavailable": "AUTHORIZATION_NOW_UNAVAILABLE",
    "pay-authorization-window-past": "AUTHORIZATION_WINDOW_PAST",
    "pay-authorization-window-exceeds-ceiling":
      "AUTHORIZATION_WINDOW_EXCEEDS_CEILING",
  };

  it("each authorization-window corpus entry retains its refusal alongside call binding", () => {
    const ids = Object.keys(AUTHORIZATION_WINDOW_SINGLE_CAUSE);
    expect(ids.length).to.equal(8);
    ids.forEach((id) => {
      const entry = CORPUS.find((candidate) => candidate.id === id);
      expect(entry, id).to.exist;
      const response = consult(
        entry!.request as never,
        entry!.policy as never,
        entry!.facts as never
      );
      const nonPass = response.results.filter(
        (r) => r.status !== "PASS" && r.id !== "transaction-matches-intent"
      );
      const bind = response.results.find(
        (r) => r.id === "transaction-matches-intent"
      )!;
      const required =
        (entry!.policy as Policy).authorizationWindow?.mode === "required";
      expect(bind.status, id).to.equal(required ? "UNVERIFIED" : "PASS");
      expect(nonPass, id).to.have.length(1);
      expect(nonPass[0].id, id).to.equal("authorization-window-within-ceiling");
      expect(nonPass[0].code, id).to.equal(
        AUTHORIZATION_WINDOW_SINGLE_CAUSE[id]
      );
      expect(response.proceed, id).to.equal(false);
    });
  });

  it("an empty Floor never earns an unauthorised allow", () => {
    const response = consultWith({ pay: [] } as Catalog)(
      makeRequest(),
      makePolicy()
    );
    expect(response.proceed).to.equal(false);
    expect(response.support).to.be.lessThan(0.8);
  });

  it("a spliced-to-empty built-in Floor never earns an unauthorised allow", () => {
    const copy = [...PAY_CATALOG.pay];
    expect(() => (copy as unknown as unknown[]).splice(0)).to.not.throw();
    const response = consultWith({ pay: copy } as Catalog)(
      makeRequest(),
      makePolicy()
    );
    expect(response.proceed).to.equal(false);
  });

  it("a getter-based double read of action.type never earns an unauthorised allow", () => {
    let reads = 0;
    const hostileRequest = {
      action: {
        get type() {
          reads += 1;
          return reads === 1 ? "refund" : "pay";
        },
        chainId: "eip155:1",
        recipient: APPROVED_RECIPIENT,
        asset: makeRequest().action.asset,
        amount: "1000000",
        target: makeRequest().action.target,
      },
    };
    const response = consult(
      hostileRequest as unknown as ConsultRequest,
      makePolicy({ perActionCaps: { pay: "1000000", refund: "9000000" } })
    );
    expect(response.proceed).to.equal(false);
  });

  it("a checker mutating its own kept result after returning never changes what consult already returned", () => {
    const liveResult = {
      id: "mutating",
      status: "PASS" as string,
      code: "TEST_PASS",
      evidenceClass: "owner-policy" as const,
      evidence: "x",
    };
    const check: ConditionDefinition["check"] = () => liveResult as never;
    const catalog: Catalog = {
      pay: [
        ...PAY_CATALOG.pay,
        testCondition({ id: "mutating", isFloor: false, check }),
      ],
    };
    const request = { ...makeRequest(), conditions: ["mutating"] };
    const response = consultWith(catalog)(
      request as ConsultRequest,
      makePolicy() as Policy
    );
    liveResult.status = "FAIL";
    // The mutation happened AFTER consult() returned, so the earlier,
    // legitimately-earned ALLOW must stand; this is not an authorised-allow
    // exemption, it is proof the frozen response cannot be altered in place.
    expect(response.proceed).to.equal(true);
  });
});
