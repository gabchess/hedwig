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
    CORPUS.forEach((entry) => {
      const response = consult(entry.request as never, entry.policy as never);
      if (entry.authorizedAllow) {
        expect(response.proceed, entry.id).to.equal(true);
        expect(response.support, entry.id).to.be.at.least(0.8);
      } else {
        expect(response.proceed, entry.id).to.equal(false);
        expect(response.support, entry.id).to.be.lessThan(0.8);
      }
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
