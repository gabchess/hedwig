import { expect } from "chai";

import { consult } from "../src";
import { MAX_AUTHORIZATION_WINDOW_SECONDS } from "../src/constants";
import {
  AUTHORIZATION_MAX_SECONDS,
  SWAP_NOW,
  makePolicy,
  makeRequest,
  makeRequiredAuthorizationWindowPolicy,
} from "./fixtures";

const ID = "authorization-window-within-ceiling";

function row(response: ReturnType<typeof consult>) {
  return response.results.find((r) => r.id === ID);
}

function run(
  authorizationWindow: unknown,
  actionOverrides: Record<string, unknown> = {},
  facts?: unknown
): ReturnType<typeof consult> {
  const request = {
    ...makeRequest(),
    action: { ...makeRequest().action, ...actionOverrides },
  };
  const policy = makePolicy({
    authorizationWindow: authorizationWindow as never,
  });
  return facts === undefined
    ? consult(request, policy)
    : consult(request, policy, facts as never);
}

const GOOD_VALID_BEFORE = SWAP_NOW + 300;

describe("authorization-window-within-ceiling", () => {
  it("mode not-required passes without reading the request or any fact", () => {
    const response = run({ mode: "not-required" });
    expect(row(response)?.status).to.equal("PASS");
    expect(row(response)?.code).to.equal("AUTHORIZATION_NOT_REQUIRED");
    expect(row(response)?.evidenceClass).to.equal("owner-policy");
    expect(response.proceed).to.equal(true);
  });

  it("mode not-required passes even with a malformed validBefore present, and proceed is unchanged", () => {
    const withoutValidBefore = run({ mode: "not-required" });
    const withBadValidBefore = run(
      { mode: "not-required" },
      { validBefore: -1 }
    );
    expect(row(withBadValidBefore)?.code).to.equal(
      "AUTHORIZATION_NOT_REQUIRED"
    );
    expect(withBadValidBefore.proceed).to.equal(withoutValidBefore.proceed);
    expect(withBadValidBefore.verdict).to.equal(withoutValidBefore.verdict);
  });

  it("a well-formed required policy plus a good validBefore earns AUTHORIZATION_WITHIN_CEILING", () => {
    const response = run(
      makeRequiredAuthorizationWindowPolicy(),
      { validBefore: GOOD_VALID_BEFORE },
      { now: SWAP_NOW }
    );
    expect(row(response)?.status).to.equal("PASS");
    expect(row(response)?.code).to.equal("AUTHORIZATION_WITHIN_CEILING");
    expect(row(response)?.evidenceClass).to.equal("owner-policy");
    expect(response.proceed).to.equal(true);
  });

  // -- authorizationWindow shape (mirrors role's mode switch) --------------
  //
  // AUTHORIZATION_POLICY_MISSING is for the wrapper itself: absent, null,
  // or not an object. AUTHORIZATION_POLICY_MALFORMED is for a well-formed
  // object whose mode is not one of the two valid strings.

  ([undefined, null, "required", []] as unknown[]).forEach(
    (authorizationWindow) => {
      it(`authorizationWindow ${JSON.stringify(
        authorizationWindow
      )} is UNVERIFIED with AUTHORIZATION_POLICY_MISSING`, () => {
        const response = run(authorizationWindow);
        expect(row(response)?.status).to.equal("UNVERIFIED");
        expect(row(response)?.code).to.equal("AUTHORIZATION_POLICY_MISSING");
        expect(response.proceed).to.equal(false);
      });
    }
  );

  it("authorizationWindow {} (an object with no mode) is UNVERIFIED with AUTHORIZATION_POLICY_MALFORMED", () => {
    const response = run({});
    expect(row(response)?.status).to.equal("UNVERIFIED");
    expect(row(response)?.code).to.equal("AUTHORIZATION_POLICY_MALFORMED");
    expect(response.proceed).to.equal(false);
  });

  (
    [
      ["capitalised", "Required"],
      ["upper case", "NOT-REQUIRED"],
      ["trailing space", "required "],
      ["leading space", " not-required"],
      ["trailing newline", "required\n"],
      ["an array holding the word", ["required"]],
      ["a boxed String", new String("not-required")],
      ["underscore", "not_required"],
      ["a boolean", true],
    ] as Array<[string, unknown]>
  ).forEach(([label, mode]) => {
    it(`does not switch the check off for mode ${label}`, () => {
      const response = run({ mode });
      expect(row(response)?.code, label).to.equal(
        "AUTHORIZATION_POLICY_MALFORMED"
      );
      expect(response.proceed, label).to.equal(false);
    });
  });

  it("not-required still passes with extra keys present: the field is never required to be absent", () => {
    const response = run({
      mode: "not-required",
      maxSeconds: AUTHORIZATION_MAX_SECONDS,
    });
    expect(row(response)?.code).to.equal("AUTHORIZATION_NOT_REQUIRED");
    expect(response.proceed).to.equal(true);
  });

  it("does not accept an array dressed as an authorizationWindow", () => {
    const authorizationWindow = Object.assign([], { mode: "not-required" });
    const response = run(authorizationWindow);
    expect(row(response)?.code).to.equal("AUTHORIZATION_POLICY_MISSING");
    expect(response.proceed).to.equal(false);
  });

  // -- maxSeconds: missing vs malformed, distinct codes --------------------

  it("mode required with maxSeconds absent is UNVERIFIED with AUTHORIZATION_CEILING_MISSING", () => {
    const response = run({ mode: "required" });
    expect(row(response)?.status).to.equal("UNVERIFIED");
    expect(row(response)?.code).to.equal("AUTHORIZATION_CEILING_MISSING");
  });

  const MAX_SECONDS_MALFORMATIONS: Array<[string, unknown]> = [
    ["zero", 0],
    ["over the ceiling", MAX_AUTHORIZATION_WINDOW_SECONDS + 1],
    ["a float", 1.5],
    ["a numeric string", "600"],
    ["NaN", Number.NaN],
    ["negative", -1],
    ["huge", 1e300],
  ];
  MAX_SECONDS_MALFORMATIONS.forEach(([label, maxSeconds]) => {
    it(`maxSeconds ${label} is UNVERIFIED with AUTHORIZATION_CEILING_MALFORMED`, () => {
      const response = run(
        makeRequiredAuthorizationWindowPolicy({ maxSeconds }),
        { validBefore: GOOD_VALID_BEFORE },
        { now: SWAP_NOW }
      );
      expect(row(response)?.status, label).to.equal("UNVERIFIED");
      expect(row(response)?.code, label).to.equal(
        "AUTHORIZATION_CEILING_MALFORMED"
      );
    });
  });

  ([1, MAX_AUTHORIZATION_WINDOW_SECONDS] as const).forEach((maxSeconds) => {
    it(`maxSeconds ${maxSeconds} (the boundary) is accepted as a well-formed ceiling`, () => {
      const response = run(
        makeRequiredAuthorizationWindowPolicy({ maxSeconds }),
        { validBefore: SWAP_NOW + maxSeconds },
        { now: SWAP_NOW }
      );
      expect(row(response)?.code, String(maxSeconds)).to.equal(
        "AUTHORIZATION_WITHIN_CEILING"
      );
    });
  });

  // -- validBefore hostile ranges -------------------------------------------

  const VALID_BEFORE_MALFORMATIONS: Array<[string, unknown]> = [
    ["zero", 0],
    ["negative", -1],
    ["a float", GOOD_VALID_BEFORE + 0.5],
    ["a string", String(GOOD_VALID_BEFORE)],
    ["2**53", 2 ** 53],
    ["missing", undefined],
    ["null", null],
    ["an array", []],
    ["a boolean", true],
  ];
  VALID_BEFORE_MALFORMATIONS.forEach(([label, validBefore]) => {
    it(`validBefore ${label} is UNVERIFIED with AUTHORIZATION_MALFORMED`, () => {
      const response = run(
        makeRequiredAuthorizationWindowPolicy(),
        { validBefore },
        { now: SWAP_NOW }
      );
      expect(row(response)?.status, label).to.equal("UNVERIFIED");
      expect(row(response)?.code, label).to.equal("AUTHORIZATION_MALFORMED");
    });
  });

  // -- facts.now -------------------------------------------------------------

  it("facts.now missing is UNVERIFIED with AUTHORIZATION_NOW_UNAVAILABLE", () => {
    const response = run(makeRequiredAuthorizationWindowPolicy(), {
      validBefore: GOOD_VALID_BEFORE,
    });
    expect(row(response)?.status).to.equal("UNVERIFIED");
    expect(row(response)?.code).to.equal("AUTHORIZATION_NOW_UNAVAILABLE");
  });

  (["2000000000", 2000000000.5, Number.NaN] as const).forEach((now) => {
    it(`facts.now ${String(now)} is AUTHORIZATION_NOW_UNAVAILABLE`, () => {
      const response = run(
        makeRequiredAuthorizationWindowPolicy(),
        { validBefore: GOOD_VALID_BEFORE },
        { now }
      );
      expect(row(response)?.code).to.equal("AUTHORIZATION_NOW_UNAVAILABLE");
    });
  });

  // -- the window comparison itself: <= vs < at both edges ------------------

  it("validBefore equal to now FAILs with AUTHORIZATION_WINDOW_PAST", () => {
    const response = run(
      makeRequiredAuthorizationWindowPolicy(),
      { validBefore: SWAP_NOW },
      { now: SWAP_NOW }
    );
    expect(row(response)?.status).to.equal("FAIL");
    expect(row(response)?.code).to.equal("AUTHORIZATION_WINDOW_PAST");
    expect(response.verdict).to.equal("DENY");
  });

  it("validBefore one second before now FAILs with AUTHORIZATION_WINDOW_PAST", () => {
    const response = run(
      makeRequiredAuthorizationWindowPolicy(),
      { validBefore: SWAP_NOW - 1 },
      { now: SWAP_NOW }
    );
    expect(row(response)?.code).to.equal("AUTHORIZATION_WINDOW_PAST");
  });

  it("validBefore one second after now PASSes (the strict edge)", () => {
    const response = run(
      makeRequiredAuthorizationWindowPolicy({ maxSeconds: 1 }),
      { validBefore: SWAP_NOW + 1 },
      { now: SWAP_NOW }
    );
    expect(row(response)?.status).to.equal("PASS");
    expect(row(response)?.code).to.equal("AUTHORIZATION_WITHIN_CEILING");
  });

  it("validBefore exactly now + maxSeconds PASSes (the inclusive ceiling edge)", () => {
    const response = run(
      makeRequiredAuthorizationWindowPolicy(),
      { validBefore: SWAP_NOW + AUTHORIZATION_MAX_SECONDS },
      { now: SWAP_NOW }
    );
    expect(row(response)?.status).to.equal("PASS");
    expect(row(response)?.code).to.equal("AUTHORIZATION_WITHIN_CEILING");
  });

  it("validBefore one second past now + maxSeconds FAILs with AUTHORIZATION_WINDOW_EXCEEDS_CEILING", () => {
    const response = run(
      makeRequiredAuthorizationWindowPolicy(),
      { validBefore: SWAP_NOW + AUTHORIZATION_MAX_SECONDS + 1 },
      { now: SWAP_NOW }
    );
    expect(row(response)?.status).to.equal("FAIL");
    expect(row(response)?.code).to.equal(
      "AUTHORIZATION_WINDOW_EXCEEDS_CEILING"
    );
    expect(response.verdict).to.equal("DENY");
  });

  // -- property loop ---------------------------------------------------------

  describe("property loop: a good (authorizationWindow, validBefore) pair", () => {
    it("mutating any single field never keeps AUTHORIZATION_WITHIN_CEILING unless the mutated value is identical", () => {
      const mutations: Array<{
        label: string;
        build: () => {
          authorizationWindow: unknown;
          validBefore: unknown;
          now: number;
        };
      }> = [
        {
          label: "maxSeconds",
          build: () => ({
            authorizationWindow: makeRequiredAuthorizationWindowPolicy({
              maxSeconds: 1,
            }),
            validBefore: GOOD_VALID_BEFORE,
            now: SWAP_NOW,
          }),
        },
        {
          label: "validBefore (into the past)",
          build: () => ({
            authorizationWindow: makeRequiredAuthorizationWindowPolicy(),
            validBefore: SWAP_NOW - 10,
            now: SWAP_NOW,
          }),
        },
        {
          label: "now (identical value)",
          build: () => ({
            authorizationWindow: makeRequiredAuthorizationWindowPolicy(),
            validBefore: GOOD_VALID_BEFORE,
            now: SWAP_NOW,
          }),
        },
        {
          label: "mode",
          build: () => ({
            authorizationWindow: { mode: "not-required" },
            validBefore: GOOD_VALID_BEFORE,
            now: SWAP_NOW,
          }),
        },
      ];

      let checked = 0;
      mutations.forEach(({ label, build }) => {
        const { authorizationWindow, validBefore, now } = build();
        const response = run(authorizationWindow, { validBefore }, { now });
        checked += 1;
        if (label === "now (identical value)") {
          expect(row(response)?.code, label).to.equal(
            "AUTHORIZATION_WITHIN_CEILING"
          );
        } else {
          expect(row(response)?.code, label).to.not.equal(
            "AUTHORIZATION_WITHIN_CEILING"
          );
        }
      });
      expect(checked).to.equal(mutations.length);
    });
  });
});
