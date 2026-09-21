import { expect } from "chai";

import {
  consult,
  type Catalog,
  type ConditionDefinition,
  type ConsultRequest,
  type Policy,
} from "../src";
import { PAY_CATALOG } from "../src/catalog";
import {
  APPROVED_RECIPIENT,
  ASSET_ADDRESS,
  POISONED_RECIPIENT,
  makePolicy,
  makeRequest,
} from "./fixtures";

// Every test below proves a NEGATIVE: a hostile input must never resolve to
// ALLOW_UNDER_POLICY. ALLOW is the only verdict that must be earned.

describe("consult hardening: B1 empty floor", () => {
  it("an empty results list never folds to ALLOW (pay: [])", () => {
    const response = consult(
      makeRequest(),
      { pay: [] } as Catalog,
      makePolicy()
    );
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
    expect(response.verdict).to.equal("UNKNOWN");
    expect(
      response.results.some(
        (r) => r.id === "floor" && r.status === "UNVERIFIED"
      )
    ).to.equal(true);
  });

  it("a pay entry holding only isFloor:false Conditions never folds to ALLOW", () => {
    const catalog: Catalog = {
      pay: [
        {
          id: "extra",
          isFloor: false,
          check: () => ({ id: "extra", status: "PASS", evidence: "x" }),
        },
      ],
    };
    const response = consult(makeRequest(), catalog, makePolicy());
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("isFloor: 0 does not count as a floor", () => {
    const catalog: Catalog = {
      pay: [
        {
          id: "x",
          isFloor: 0 as unknown as boolean,
          check: () => ({ id: "x", status: "PASS", evidence: "y" }),
        },
      ],
    };
    const response = consult(makeRequest(), catalog, makePolicy());
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });
});

describe("consult hardening: B2 checker result validation", () => {
  function catalogWithChecker(check: ConditionDefinition["check"]): Catalog {
    return { pay: [{ id: "recipient-matches-policy", isFloor: true, check }] };
  }

  it("a lowercase status string never resolves to ALLOW", () => {
    const catalog = catalogWithChecker(
      () =>
        ({
          id: "recipient-matches-policy",
          status: "pass",
          evidence: "x",
        } as unknown as ReturnType<ConditionDefinition["check"]>)
    );
    const response = consult(makeRequest(), catalog, makePolicy());
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("an unrecognised status string (ERROR) never resolves to ALLOW", () => {
    const catalog = catalogWithChecker(
      () =>
        ({
          id: "recipient-matches-policy",
          status: "ERROR",
          evidence: "x",
        } as unknown as ReturnType<ConditionDefinition["check"]>)
    );
    const response = consult(makeRequest(), catalog, makePolicy());
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("a checker returning {} never resolves to ALLOW and does not crash", () => {
    const catalog = catalogWithChecker(
      () => ({} as unknown as ReturnType<ConditionDefinition["check"]>)
    );
    expect(() => consult(makeRequest(), catalog, makePolicy())).to.not.throw();
    const response = consult(makeRequest(), catalog, makePolicy());
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("an async checker (a Promise) never resolves to ALLOW", () => {
    const catalog = catalogWithChecker((() =>
      Promise.resolve({
        id: "recipient-matches-policy",
        status: "PASS",
        evidence: "x",
      })) as unknown as ConditionDefinition["check"]);
    const response = consult(makeRequest(), catalog, makePolicy());
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("a result whose id differs from the definition's id never resolves to ALLOW, and the real floor id is still reported", () => {
    const catalog = catalogWithChecker(() => ({
      id: "not-the-real-id",
      status: "PASS",
      evidence: "x",
    }));
    const response = consult(makeRequest(), catalog, makePolicy());
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
    expect(
      response.results.some((r) => r.id === "recipient-matches-policy")
    ).to.equal(true);
  });

  it("a checker returning undefined does not crash consult and never resolves to ALLOW", () => {
    const catalog = catalogWithChecker(
      (() => undefined) as unknown as ConditionDefinition["check"]
    );
    expect(() => consult(makeRequest(), catalog, makePolicy())).to.not.throw();
    const response = consult(makeRequest(), catalog, makePolicy());
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("every Floor id appears exactly once in results on a clean pass", () => {
    const response = consult(makeRequest(), PAY_CATALOG, makePolicy());
    response.floorIds.forEach((id) => {
      expect(response.results.filter((r) => r.id === id)).to.have.length(1);
    });
  });
});

describe("consult hardening: B3 amount shape", () => {
  const HOSTILE_AMOUNTS: unknown[] = [
    "-5",
    "-99999999999999999999999999",
    -1,
    "",
    "   ",
    [],
    " 10 ",
    "\n7\t",
    "+5",
    [5],
    "0x10",
    "0b11",
    "0o7",
    true,
    false,
  ];

  it("a malformed amount never resolves to ALLOW", () => {
    HOSTILE_AMOUNTS.forEach((amount) => {
      const request = makeRequest({
        action: {
          ...makeRequest().action,
          amount: amount as unknown as string,
        },
      });
      const response = consult(request, PAY_CATALOG, makePolicy());
      expect(response.verdict, `amount ${JSON.stringify(amount)}`).to.not.equal(
        "ALLOW_UNDER_POLICY"
      );
    });
  });

  it("an amount of zero fails: never what the owner approved", () => {
    const request = makeRequest({
      action: { ...makeRequest().action, amount: "0" },
    });
    const response = consult(request, PAY_CATALOG, makePolicy());
    const result = response.results.find((r) => r.id === "amount-within-cap");
    expect(result?.status).to.equal("FAIL");
    expect(response.verdict).to.equal("DENY");
  });
});

describe("consult hardening: B4 frozen catalog", () => {
  it("the catalog cannot be spliced to an empty floor", () => {
    expect(() =>
      (PAY_CATALOG.pay as unknown as unknown[]).splice(0)
    ).to.throw();
    const response = consult(makeRequest(), PAY_CATALOG, makePolicy());
    expect(response.results).to.have.length(5);
    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
  });
});

describe("consult hardening: B5 EVM address value comparison", () => {
  it("a lowercase or checksummed form of an approved recipient still passes", () => {
    const lower = APPROVED_RECIPIENT.toLowerCase();
    const upper = "0x" + APPROVED_RECIPIENT.slice(2).toUpperCase();
    [lower, upper].forEach((recipient) => {
      const response = consult(
        makeRequest({ action: { ...makeRequest().action, recipient } }),
        PAY_CATALOG,
        makePolicy()
      );
      expect(
        response.results.find((r) => r.id === "recipient-matches-policy")
          ?.status,
        recipient
      ).to.equal("PASS");
    });
  });

  it("a lowercase form of a poison-flagged recipient still fails", () => {
    const lower = POISONED_RECIPIENT.toLowerCase();
    const response = consult(
      makeRequest({ action: { ...makeRequest().action, recipient: lower } }),
      PAY_CATALOG,
      makePolicy({ approvedRecipients: [lower] })
    );
    expect(
      response.results.find((r) => r.id === "recipient-not-poison-derived")
        ?.status
    ).to.equal("FAIL");
    expect(response.verdict).to.equal("DENY");
  });

  it("a lookalike sharing only the first and last four characters still fails", () => {
    const lookalike =
      APPROVED_RECIPIENT.slice(0, 6) +
      "9".repeat(APPROVED_RECIPIENT.length - 10) +
      APPROVED_RECIPIENT.slice(-4);
    const response = consult(
      makeRequest({
        action: { ...makeRequest().action, recipient: lookalike },
      }),
      PAY_CATALOG,
      makePolicy()
    );
    expect(
      response.results.find((r) => r.id === "recipient-matches-policy")?.status
    ).to.equal("FAIL");
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("a non-EVM chain family cannot be validated and returns UNVERIFIED, never ALLOW", () => {
    const response = consult(
      makeRequest({
        action: { ...makeRequest().action, chainId: "solana:mainnet" },
      }),
      PAY_CATALOG,
      makePolicy({ chainId: "solana:mainnet" })
    );
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
    ["recipient-matches-policy", "recipient-not-poison-derived"].forEach(
      (id) => {
        expect(response.results.find((r) => r.id === id)?.status).to.equal(
          "UNVERIFIED"
        );
      }
    );
  });

  it("a malformed approved-policy entry never matches anything, even a byte-identical malformed recipient", () => {
    const malformed = "0xnotreallyanaddress";
    const response = consult(
      makeRequest({
        action: { ...makeRequest().action, recipient: malformed },
      }),
      PAY_CATALOG,
      makePolicy({ approvedRecipients: [malformed] })
    );
    expect(
      response.results.find((r) => r.id === "recipient-matches-policy")?.status
    ).to.not.equal("PASS");
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("a lowercase canonical asset contract address still passes asset-is-canonical", () => {
    const lower = ASSET_ADDRESS.toLowerCase();
    const response = consult(
      makeRequest({
        action: {
          ...makeRequest().action,
          asset: { symbol: "USDC", contractAddress: lower },
        },
      }),
      PAY_CATALOG,
      makePolicy()
    );
    expect(
      response.results.find((r) => r.id === "asset-is-canonical")?.status
    ).to.equal("PASS");
  });
});

describe("consult hardening: B6 permits strictness", () => {
  const HOSTILE_PERMITS: unknown[] = ["false", "no", 1, {}, []];

  it("a truthy-but-not-true permits value never resolves to ALLOW", () => {
    HOSTILE_PERMITS.forEach((permits) => {
      const response = consult(
        makeRequest(),
        PAY_CATALOG,
        makePolicy({ permits: permits as unknown as boolean })
      );
      expect(response.verdict, JSON.stringify(permits)).to.not.equal(
        "ALLOW_UNDER_POLICY"
      );
    });
  });
});

describe("consult hardening: S1 consult never throws", () => {
  const HOSTILE_ACTION_TYPES = [
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
  ];

  it("a prototype-chain action type does not throw and never resolves to ALLOW", () => {
    HOSTILE_ACTION_TYPES.forEach((type) => {
      const request = makeRequest({
        action: { ...makeRequest().action, type },
      });
      expect(() => consult(request, PAY_CATALOG, makePolicy())).to.not.throw();
      const response = consult(request, PAY_CATALOG, makePolicy());
      expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
    });
  });

  it("a missing request or action does not throw", () => {
    expect(() =>
      consult(undefined as unknown as ConsultRequest, PAY_CATALOG, makePolicy())
    ).to.not.throw();
    expect(() =>
      consult({} as unknown as ConsultRequest, PAY_CATALOG, makePolicy())
    ).to.not.throw();
    expect(
      consult(undefined as unknown as ConsultRequest, PAY_CATALOG, makePolicy())
        .verdict
    ).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("a malformed conditions field does not throw, is reported, and the floor still runs", () => {
    ["not-an-array", { nope: true }, 42].forEach((conditions) => {
      const request = {
        ...makeRequest(),
        conditions: conditions as unknown as string[],
      };
      expect(() => consult(request, PAY_CATALOG, makePolicy())).to.not.throw();
      const response = consult(request, PAY_CATALOG, makePolicy());
      expect(response.results.some((r) => r.id === "input-shape")).to.equal(
        true
      );
      expect(response.floorIds).to.have.length(5);
    });
  });

  it("an undefined policy or catalog does not throw", () => {
    expect(() =>
      consult(makeRequest(), undefined as unknown as Catalog, makePolicy())
    ).to.not.throw();
    expect(() =>
      consult(makeRequest(), PAY_CATALOG, undefined as unknown as Policy)
    ).to.not.throw();
    expect(
      consult(makeRequest(), undefined as unknown as Catalog, makePolicy())
        .verdict
    ).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("a getter that throws does not crash consult", () => {
    const hostile = {
      get action(): never {
        throw new Error("boom");
      },
    };
    expect(() =>
      consult(hostile as unknown as ConsultRequest, PAY_CATALOG, makePolicy())
    ).to.not.throw();
    expect(
      consult(hostile as unknown as ConsultRequest, PAY_CATALOG, makePolicy())
        .verdict
    ).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("a thrown value with no constructor does not crash consult's evidence extraction", () => {
    const hostile = {
      get action(): never {
        throw Object.create(null);
      },
    };
    expect(() =>
      consult(hostile as unknown as ConsultRequest, PAY_CATALOG, makePolicy())
    ).to.not.throw();
  });
});

describe("consult hardening: S2 prototype-chain keyed lookups", () => {
  it("prototype-chain asset lookup keys never fabricate a PASS", () => {
    const request = makeRequest({
      action: {
        ...makeRequest().action,
        chainId: "constructor",
        asset: { symbol: "name", contractAddress: "Object" },
      },
    });
    const response = consult(
      request,
      PAY_CATALOG,
      makePolicy({ chainId: "constructor" })
    );
    expect(
      response.results.find((r) => r.id === "asset-is-canonical")?.status
    ).to.not.equal("PASS");
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("a prototype-chain action type key never resolves a perActionCaps entry", () => {
    const request = makeRequest({
      action: { ...makeRequest().action, type: "constructor" },
    });
    const response = consult(request, PAY_CATALOG, makePolicy());
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });
});

describe("consult hardening: S3 approvedRecipients shape", () => {
  it("approvedRecipients as a string never substring-matches", () => {
    const response = consult(
      makeRequest({ action: { ...makeRequest().action, recipient: "0x0000" } }),
      PAY_CATALOG,
      makePolicy({
        approvedRecipients: APPROVED_RECIPIENT as unknown as string[],
      })
    );
    expect(
      response.results.find((r) => r.id === "recipient-matches-policy")?.status
    ).to.equal("UNVERIFIED");
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("empty, undefined, or sparse recipient entries never match an empty recipient", () => {
    const hostileLists: unknown[] = [[""], [undefined], new Array(3)];
    hostileLists.forEach((approvedRecipients) => {
      const response = consult(
        makeRequest({ action: { ...makeRequest().action, recipient: "" } }),
        PAY_CATALOG,
        makePolicy({
          approvedRecipients: approvedRecipients as unknown as string[],
        })
      );
      expect(
        response.results.find((r) => r.id === "recipient-matches-policy")
          ?.status
      ).to.not.equal("PASS");
      expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
    });
  });
});

describe("consult hardening: S4 checker purity", () => {
  it("a checker that mutates the policy cannot poison a later Floor check", () => {
    const evilRecipient = "0x" + "E".repeat(40);
    const mutator: ConditionDefinition = {
      id: "mutator",
      isFloor: true,
      check: (_request, context) => {
        try {
          (context.policy.approvedRecipients as string[]).push(evilRecipient);
        } catch {
          // frozen policy: the mutation is expected to fail
        }
        return {
          id: "mutator",
          status: "PASS",
          evidence: "attempted mutation",
        };
      },
    };
    const catalog: Catalog = { pay: [mutator, ...PAY_CATALOG.pay] };
    const request = makeRequest({
      action: { ...makeRequest().action, recipient: evilRecipient },
    });
    const response = consult(request, catalog, makePolicy());
    expect(
      response.results.find((r) => r.id === "recipient-matches-policy")?.status
    ).to.equal("FAIL");
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });
});

describe("consult hardening: S7 dedupe and evidence cap", () => {
  it("a repeated extra condition id runs its checker once, not twice", () => {
    let calls = 0;
    const counted: ConditionDefinition = {
      id: "counted",
      isFloor: false,
      check: () => {
        calls += 1;
        return { id: "counted", status: "PASS", evidence: "x" };
      },
    };
    const catalog: Catalog = { pay: [...PAY_CATALOG.pay, counted] };
    const request = { ...makeRequest(), conditions: ["counted", "counted"] };
    consult(request, catalog, makePolicy());
    expect(calls).to.equal(1);
  });

  it("evidence that echoes caller input is capped at 120 characters, not embedded in full", () => {
    const longRecipient = "0x" + "1".repeat(10000);
    const response = consult(
      makeRequest({
        action: { ...makeRequest().action, recipient: longRecipient },
      }),
      PAY_CATALOG,
      makePolicy()
    );
    const result = response.results.find(
      (r) => r.id === "recipient-matches-policy"
    );
    expect(result?.evidence).to.not.include(longRecipient);
    expect(result?.evidence.length).to.be.lessThan(longRecipient.length);
  });
});

describe("consult hardening: property test", () => {
  it("mutating any single request or policy field never throws and never yields ALLOW_UNDER_POLICY", () => {
    const MUTATIONS: unknown[] = [
      undefined,
      null,
      "",
      " ",
      0,
      -1,
      NaN,
      true,
      [],
      {},
      "__proto__",
      "constructor",
      "x".repeat(10000),
    ];
    const base = makeRequest();
    const basePolicy = makePolicy();
    let total = 0;

    function attempt(request: unknown, policy: unknown, allowIsEarned = false) {
      total += 1;
      let response: ReturnType<typeof consult> | undefined;
      expect(() => {
        response = consult(
          request as unknown as ConsultRequest,
          PAY_CATALOG,
          policy as unknown as Policy
        );
      }).to.not.throw();
      if (!allowIsEarned) {
        expect(response?.verdict).to.not.equal("ALLOW_UNDER_POLICY");
      }
    }

    // conditions only ever ADDS non-Floor checks; undefined or an empty list
    // is exactly "no extra conditions", the same as the default request,
    // which legitimately earns ALLOW when the rest of the request is valid.
    const conditionsValueIsStillValid = (value: unknown) =>
      value === undefined || (Array.isArray(value) && value.length === 0);

    const requestMutators: {
      build: (value: unknown) => unknown;
      allowIsEarned?: (value: unknown) => boolean;
    }[] = [
      { build: (v) => ({ ...base, action: { ...base.action, recipient: v } }) },
      { build: (v) => ({ ...base, action: { ...base.action, amount: v } }) },
      { build: (v) => ({ ...base, action: { ...base.action, asset: v } }) },
      {
        build: (v) => ({
          ...base,
          action: {
            ...base.action,
            asset: { ...base.action.asset, symbol: v },
          },
        }),
      },
      {
        build: (v) => ({
          ...base,
          action: {
            ...base.action,
            asset: { ...base.action.asset, contractAddress: v },
          },
        }),
      },
      { build: (v) => ({ ...base, action: { ...base.action, chainId: v } }) },
      { build: (v) => ({ ...base, action: v }) },
      { build: (v) => ({ ...base, action: { ...base.action, type: v } }) },
      {
        build: (v) => ({ ...base, conditions: v }),
        allowIsEarned: conditionsValueIsStillValid,
      },
    ];

    requestMutators.forEach(({ build, allowIsEarned }) => {
      MUTATIONS.forEach((value) =>
        attempt(build(value), basePolicy, allowIsEarned?.(value) ?? false)
      );
    });

    // permits: true is the base fixture's own correct value, not a
    // mutation; substituting it back in changes nothing and legitimately
    // still earns ALLOW.
    const policyMutators: {
      field: keyof Policy;
      allowIsEarned?: (value: unknown) => boolean;
    }[] = [
      { field: "permits", allowIsEarned: (value) => value === true },
      { field: "chainId" },
      { field: "approvedRecipients" },
      { field: "perActionCaps" },
    ];
    policyMutators.forEach(({ field, allowIsEarned }) => {
      MUTATIONS.forEach((value) =>
        attempt(
          base,
          { ...basePolicy, [field]: value },
          allowIsEarned?.(value) ?? false
        )
      );
    });

    expect(total).to.equal(
      requestMutators.length * MUTATIONS.length +
        policyMutators.length * MUTATIONS.length
    );
    expect(total).to.be.greaterThan(150);
  });
});
