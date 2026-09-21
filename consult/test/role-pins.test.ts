import { expect } from "chai";

import { consult } from "../src";
import { PAY_CATALOG, validateCatalog } from "../src/catalog";
import type { Catalog } from "../src/catalog";
import {
  ROLE_HOLDER,
  SWAP_NOW,
  makeGoodRoleFact,
  makePolicy,
  makeRequest,
  makeRequiredRolePolicy,
  makeSwapPolicy,
  makeSwapRequest,
  testCondition,
} from "./fixtures";

type Build = {
  name: string;
  request: (extra: Record<string, unknown>) => unknown;
  policy: (role: unknown) => unknown;
};

const ACTIONS: Build[] = [
  {
    name: "pay",
    request: (extra) => ({ ...makeRequest(), ...extra }),
    policy: (role) => makePolicy({ role } as never),
  },
  {
    name: "swap",
    request: (extra) => ({ ...makeSwapRequest(), ...extra }),
    policy: (role) => makeSwapPolicy({ role } as never),
  },
];

function roleRow(response: ReturnType<typeof consult>) {
  return response.results.find(
    (result) => result.id === "role-requirement-met"
  );
}

ACTIONS.forEach(({ name, request, policy }) => {
  describe(`role-requirement-met reads only the policy and the facts argument: ${name}`, () => {
    it("ignores a fact and a role planted anywhere in the request", () => {
      const fact = makeGoodRoleFact();
      const planted = request({
        facts: { now: SWAP_NOW, solanaRole: fact },
        solanaRole: fact,
        role: { mode: "not-required" },
      }) as { action: Record<string, unknown> };
      planted.action = {
        ...planted.action,
        solanaRole: fact,
        facts: { now: SWAP_NOW, solanaRole: fact },
        role: { mode: "not-required" },
      };

      const response = consult(
        planted as never,
        policy(makeRequiredRolePolicy()) as never,
        { now: SWAP_NOW } as never
      );

      expect(roleRow(response)?.code).to.match(/ROLE_FACT_MISSING$/);
      expect(response.proceed).to.equal(false);
    });

    [
      ["capitalised", "Not-Required"],
      ["upper case", "NOT-REQUIRED"],
      ["trailing space", "not-required "],
      ["leading space", " not-required"],
      ["trailing newline", "not-required\n"],
      ["an array holding the word", ["not-required"]],
      ["a boxed String", new String("not-required")],
      ["underscore", "not_required"],
    ].forEach(([label, mode]) => {
      it(`does not switch the check off for mode ${label}`, () => {
        const response = consult(
          request({}) as never,
          policy({ mode }) as never,
          { now: SWAP_NOW } as never
        );
        expect(roleRow(response)?.code).to.match(/ROLE_POLICY_MISSING$/);
        expect(response.proceed).to.equal(false);
      });
    });

    it("does not accept an array dressed as a role", () => {
      const role = Object.assign([], { mode: "not-required" });
      const response = consult(
        request({}) as never,
        policy(role) as never,
        { now: SWAP_NOW } as never
      );
      expect(roleRow(response)?.code).to.match(/ROLE_POLICY_MISSING$/);
      expect(response.proceed).to.equal(false);
    });

    ["2000000000", 2000000000.5, Number.NaN].forEach((now) => {
      it(`cannot judge a fact's age against now = ${String(now)}`, () => {
        const response = consult(
          request({}) as never,
          policy(makeRequiredRolePolicy()) as never,
          { now, solanaRole: makeGoodRoleFact() } as never
        );
        expect(roleRow(response)?.code).to.match(/ROLE_FACT_AGE_UNKNOWN$/);
        expect(response.proceed).to.equal(false);
      });
    });

    [
      ["a trailing newline", `${ROLE_HOLDER}\n`],
      ["45 characters", `${ROLE_HOLDER}${"A".repeat(45 - ROLE_HOLDER.length)}`],
      ["31 characters", ROLE_HOLDER.slice(0, 31)],
      ["a leading space", ` ${ROLE_HOLDER}`],
    ].forEach(([label, holder]) => {
      it(`treats a holder with ${label} as a malformed policy`, () => {
        const response = consult(
          request({}) as never,
          policy(makeRequiredRolePolicy({ holder })) as never,
          { now: SWAP_NOW, solanaRole: makeGoodRoleFact() } as never
        );
        expect(roleRow(response)?.code).to.match(/ROLE_POLICY_MALFORMED$/);
        expect(response.proceed).to.equal(false);
      });
    });
  });
});

describe("a Condition with several PASS codes", () => {
  function catalogWith(pass: unknown, passClasses: Record<string, string>) {
    return {
      pay: [
        ...PAY_CATALOG.pay,
        testCondition({
          id: "two-passes",
          isFloor: false,
          codes: {
            pass: pass as never,
            fail: ["TEST_FAIL"],
            unverified: ["TEST_UNVERIFIED"],
          },
          codeEvidenceClass: {
            ...passClasses,
            TEST_FAIL: "owner-policy",
            TEST_UNVERIFIED: "not-verifiable",
          } as never,
          check: () => ({
            id: "two-passes",
            status: "UNVERIFIED",
            code: "TEST_UNVERIFIED",
            evidenceClass: "not-verifiable",
            evidence: "n/a",
          }),
        }),
      ],
    } as Catalog;
  }

  it("is sound when every PASS code has verifiable evidence", () => {
    expect(
      validateCatalog(
        catalogWith(["TEST_PASS_A", "TEST_PASS_B"], {
          TEST_PASS_A: "owner-policy",
          TEST_PASS_B: "onchain-read",
        })
      )
    ).to.equal(undefined);
  });

  it("is rejected when a LATER PASS code is not-verifiable", () => {
    expect(
      validateCatalog(
        catalogWith(["TEST_PASS_A", "TEST_PASS_B"], {
          TEST_PASS_A: "owner-policy",
          TEST_PASS_B: "not-verifiable",
        })
      )
    ).to.be.a("string");
  });

  it("is rejected when it declares no PASS code at all", () => {
    expect(validateCatalog(catalogWith([], {}))).to.be.a("string");
  });
});
