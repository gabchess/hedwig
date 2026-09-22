import { expect } from "chai";

import { consult, type ConsultResponse } from "../src";
import type {
  Catalog,
  ConditionDefinition,
  ConsultRequest,
  Policy,
} from "../src/catalog";
import { PAY_CATALOG } from "../src/catalog";
import { foldVerdict } from "../src/fold";
import { consultWith } from "../src/internal";
import {
  APPROVED_RECIPIENT,
  ASSET_ADDRESS,
  POISONED_RECIPIENT,
  RECIPIENT_MATCHES_POLICY_DEFINITION,
  makePolicy,
  makeRequest,
  testCondition,
} from "./fixtures";

// Every test below proves a NEGATIVE: a hostile input must never resolve to
// ALLOW_UNDER_POLICY. ALLOW is the only verdict that must be earned.

describe("consult hardening: B1 empty floor", () => {
  it("a catalog with no Floor Condition for an action type is rejected at consultWith time (pay: [])", () => {
    const response = consultWith({ pay: [] } as Catalog)(
      makeRequest(),
      makePolicy()
    );
    expect(response.verdict).to.equal("UNKNOWN");
    expect(
      response.results.some(
        (r) => r.id === "input-shape" && r.status === "UNVERIFIED"
      )
    ).to.equal(true);
  });

  it("a pay entry holding only isFloor:false Conditions is rejected at consultWith time", () => {
    const catalog: Catalog = {
      pay: [
        testCondition({
          id: "extra",
          isFloor: false,
          check: () => ({
            id: "extra",
            status: "PASS",
            code: "TEST_PASS",
            evidenceClass: "owner-policy",
            evidence: "x",
          }),
        }),
      ],
    };
    const response = consultWith(catalog)(makeRequest(), makePolicy());
    expect(response.verdict).to.equal("UNKNOWN");
    expect(response.results.some((r) => r.id === "input-shape")).to.equal(true);
  });

  it("isFloor: 0 does not count as a floor and is rejected at consultWith time", () => {
    const catalog: Catalog = {
      pay: [
        testCondition({
          id: "x",
          isFloor: 0 as unknown as boolean,
          check: () => ({
            id: "x",
            status: "PASS",
            code: "TEST_PASS",
            evidenceClass: "owner-policy",
            evidence: "y",
          }),
        }),
      ],
    };
    const response = consultWith(catalog)(makeRequest(), makePolicy());
    expect(response.verdict).to.equal("UNKNOWN");
    expect(response.results.some((r) => r.id === "input-shape")).to.equal(true);
  });
});

describe("consult hardening: B2 checker result validation", () => {
  function catalogWithChecker(check: ConditionDefinition["check"]): Catalog {
    return { pay: [{ ...RECIPIENT_MATCHES_POLICY_DEFINITION, check }] };
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
    const response = consultWith(catalog)(makeRequest(), makePolicy());
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
    const response = consultWith(catalog)(makeRequest(), makePolicy());
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("a checker returning {} never resolves to ALLOW and does not crash", () => {
    const catalog = catalogWithChecker(
      () => ({} as unknown as ReturnType<ConditionDefinition["check"]>)
    );
    expect(() =>
      consultWith(catalog)(makeRequest(), makePolicy())
    ).to.not.throw();
    const response = consultWith(catalog)(makeRequest(), makePolicy());
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("an async checker (a Promise) never resolves to ALLOW", () => {
    const catalog = catalogWithChecker((() =>
      Promise.resolve({
        id: "recipient-matches-policy",
        status: "PASS",
        evidence: "x",
      })) as unknown as ConditionDefinition["check"]);
    const response = consultWith(catalog)(makeRequest(), makePolicy());
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("a result whose id differs from the definition's id never resolves to ALLOW, and the real floor id is still reported", () => {
    const catalog = catalogWithChecker(() => ({
      id: "not-the-real-id",
      status: "PASS",
      code: "RECIPIENT_MATCHES_POLICY",
      evidenceClass: "owner-policy",
      evidence: "x",
    }));
    const response = consultWith(catalog)(makeRequest(), makePolicy());
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
    expect(
      response.results.some((r) => r.id === "recipient-matches-policy")
    ).to.equal(true);
  });

  it("a checker returning undefined does not crash consult and never resolves to ALLOW", () => {
    const catalog = catalogWithChecker(
      (() => undefined) as unknown as ConditionDefinition["check"]
    );
    expect(() =>
      consultWith(catalog)(makeRequest(), makePolicy())
    ).to.not.throw();
    const response = consultWith(catalog)(makeRequest(), makePolicy());
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("every Floor id appears exactly once in results on a clean pass", () => {
    const response = consult(makeRequest(), makePolicy());
    response.floorIds.forEach((id) => {
      expect(response.results.filter((r) => r.id === id)).to.have.length(1);
    });
  });

  it("reads a status getter that answers PASS four times then FAIL exactly once, so the frozen result never later reports FAIL", () => {
    let reads = 0;
    const catalog = catalogWithChecker(() => ({
      id: "recipient-matches-policy",
      get status() {
        reads += 1;
        return reads <= 4 ? "PASS" : "FAIL";
      },
      code: "RECIPIENT_MATCHES_POLICY",
      evidenceClass: "owner-policy",
      evidence: "x",
    }));
    const response = consultWith(catalog)(makeRequest(), makePolicy());
    // The single read said PASS, so ALLOW is legitimately earned; reading
    // the returned result again must not invoke the getter a second time
    // and must not surface the FAIL the getter would answer on a re-read.
    expect(reads).to.equal(1);
    expect(
      response.results.find((r) => r.id === "recipient-matches-policy")?.status
    ).to.equal("PASS");
    expect(reads).to.equal(1);
    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
  });

  it("a checker result whose status getter answers UNVERIFIED, UNVERIFIED, PASS never resolves to ALLOW, and the getter is read at most once", () => {
    const answers = ["UNVERIFIED", "UNVERIFIED", "PASS"];
    let reads = 0;
    const catalog = catalogWithChecker(
      () =>
        ({
          id: "recipient-matches-policy",
          get status() {
            const value = answers[Math.min(reads, answers.length - 1)];
            reads += 1;
            return value;
          },
          evidence: "x",
        } as unknown as ReturnType<ConditionDefinition["check"]>)
    );
    const response = consultWith(catalog)(makeRequest(), makePolicy());
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
    expect(reads).to.equal(1);
  });

  it("a checker that keeps a reference to its own result and flips it to FAIL afterward cannot change what consult already returned", () => {
    const liveResult = {
      id: "recipient-matches-policy",
      status: "PASS" as string,
      code: "RECIPIENT_MATCHES_POLICY",
      evidenceClass: "owner-policy",
      evidence: "x",
    };
    const catalog = catalogWithChecker(() => liveResult as any);
    const response = consultWith(catalog)(makeRequest(), makePolicy());
    // The result was PASS at the moment it was checked, so ALLOW is
    // legitimately earned; mutating the checker's own kept reference
    // afterward must not retroactively change the returned result.
    liveResult.status = "FAIL";
    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(
      response.results.find((r) => r.id === "recipient-matches-policy")?.status
    ).to.equal("PASS");
  });

  it("a Proxy result cannot have its reported status changed by mutating the underlying target after consult already returned", () => {
    const target = {
      id: "recipient-matches-policy",
      status: "PASS",
      code: "RECIPIENT_MATCHES_POLICY",
      evidenceClass: "owner-policy",
      evidence: "x",
    };
    const proxied = new Proxy(target, {});
    const catalog = catalogWithChecker(() => proxied as any);
    const response = consultWith(catalog)(makeRequest(), makePolicy());
    target.status = "FAIL";

    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(
      response.results.find((r) => r.id === "recipient-matches-policy")?.status
    ).to.equal("PASS");
  });

  it("the verdict always equals foldVerdict re-applied to the returned results, even after the checker's kept reference mutates", () => {
    const liveResult = {
      id: "recipient-matches-policy",
      status: "PASS" as string,
      code: "RECIPIENT_MATCHES_POLICY",
      evidenceClass: "owner-policy",
      evidence: "x",
    };
    const catalog = catalogWithChecker(() => liveResult as any);
    const response = consultWith(catalog)(makeRequest(), makePolicy());
    liveResult.status = "FAIL";

    const refolded = foldVerdict(response.results, true);
    expect(response.verdict).to.equal(refolded);
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
      const response = consult(request, makePolicy());
      expect(response.verdict, `amount ${JSON.stringify(amount)}`).to.not.equal(
        "ALLOW_UNDER_POLICY"
      );
    });
  });

  it("an amount of zero fails: never what the owner approved", () => {
    const request = makeRequest({
      action: { ...makeRequest().action, amount: "0" },
    });
    const response = consult(request, makePolicy());
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
    const response = consult(makeRequest(), makePolicy());
    expect(response.results).to.have.length(8);
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
      expect(() => consult(request, makePolicy())).to.not.throw();
      const response = consult(request, makePolicy());
      expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
    });
  });

  it("a missing request or action does not throw", () => {
    expect(() =>
      consult(undefined as unknown as ConsultRequest, makePolicy())
    ).to.not.throw();
    expect(() =>
      consult({} as unknown as ConsultRequest, makePolicy())
    ).to.not.throw();
    expect(
      consult(undefined as unknown as ConsultRequest, makePolicy()).verdict
    ).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("a malformed conditions field does not throw, is reported, and the floor still runs", () => {
    ["not-an-array", { nope: true }, 42].forEach((conditions) => {
      const request = {
        ...makeRequest(),
        conditions: conditions as unknown as string[],
      };
      expect(() => consult(request, makePolicy())).to.not.throw();
      const response = consult(request, makePolicy());
      expect(response.results.some((r) => r.id === "input-shape")).to.equal(
        true
      );
      expect(response.floorIds).to.have.length(8);
    });
  });

  it("an undefined policy does not throw", () => {
    expect(() =>
      consult(makeRequest(), undefined as unknown as Policy)
    ).to.not.throw();
    expect(
      consult(makeRequest(), undefined as unknown as Policy).verdict
    ).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("a getter that throws does not crash consult", () => {
    const hostile = {
      get action(): never {
        throw new Error("boom");
      },
    };
    expect(() =>
      consult(hostile as unknown as ConsultRequest, makePolicy())
    ).to.not.throw();
    expect(
      consult(hostile as unknown as ConsultRequest, makePolicy()).verdict
    ).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("a thrown value with no constructor does not crash consult's evidence extraction", () => {
    const hostile = {
      get action(): never {
        throw Object.create(null);
      },
    };
    expect(() =>
      consult(hostile as unknown as ConsultRequest, makePolicy())
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
    const response = consult(request, makePolicy({ chainId: "constructor" }));
    expect(
      response.results.find((r) => r.id === "asset-is-canonical")?.status
    ).to.not.equal("PASS");
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("a prototype-chain action type key never resolves a perActionCaps entry", () => {
    const request = makeRequest({
      action: { ...makeRequest().action, type: "constructor" },
    });
    const response = consult(request, makePolicy());
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });
});

describe("consult hardening: S3 approvedRecipients shape", () => {
  it("approvedRecipients as a string never substring-matches", () => {
    const response = consult(
      makeRequest({ action: { ...makeRequest().action, recipient: "0x0000" } }),
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
    const mutator: ConditionDefinition = testCondition({
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
          code: "TEST_PASS",
          evidenceClass: "owner-policy",
          evidence: "attempted mutation",
        };
      },
    });
    const catalog: Catalog = { pay: [mutator, ...PAY_CATALOG.pay] };
    const request = makeRequest({
      action: { ...makeRequest().action, recipient: evilRecipient },
    });
    const response = consultWith(catalog)(request, makePolicy());
    expect(
      response.results.find((r) => r.id === "recipient-matches-policy")?.status
    ).to.equal("FAIL");
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });
});

describe("consult hardening: S7 dedupe and evidence cap", () => {
  it("a repeated extra condition id runs its checker once, not twice", () => {
    let calls = 0;
    const counted: ConditionDefinition = testCondition({
      id: "counted",
      isFloor: false,
      check: () => {
        calls += 1;
        return {
          id: "counted",
          status: "PASS",
          code: "TEST_PASS",
          evidenceClass: "owner-policy",
          evidence: "x",
        };
      },
    });
    const catalog: Catalog = { pay: [...PAY_CATALOG.pay, counted] };
    const request = { ...makeRequest(), conditions: ["counted", "counted"] };
    consultWith(catalog)(request, makePolicy());
    expect(calls).to.equal(1);
  });

  it("evidence that echoes caller input is capped at 120 characters, not embedded in full", () => {
    const longRecipient = "0x" + "1".repeat(10000);
    const response = consult(
      makeRequest({
        action: { ...makeRequest().action, recipient: longRecipient },
      }),
      makePolicy()
    );
    const result = response.results.find(
      (r) => r.id === "recipient-matches-policy"
    );
    expect(result?.evidence).to.not.include(longRecipient);
    expect(result?.evidence.length).to.be.lessThan(longRecipient.length);
  });
});

describe("consult hardening: item 1 clone-first reads", () => {
  it("reads action.type from the frozen clone only: a getter that answers 'refund' once then 'pay' cannot cross-apply another action type's cap", () => {
    let calls = 0;
    const hostileRequest = {
      action: {
        get type() {
          calls += 1;
          return calls === 1 ? "refund" : "pay";
        },
        chainId: "eip155:1",
        recipient: APPROVED_RECIPIENT,
        asset: { symbol: "USDC", contractAddress: ASSET_ADDRESS },
        amount: "5000000",
      },
    };
    const policy = makePolicy({
      perActionCaps: { pay: "1000000", refund: "9000000" },
    });

    const response = consult(
      hostileRequest as unknown as ConsultRequest,
      policy
    );

    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
    expect(calls).to.equal(1);
  });
});

describe("consult hardening: item 4 bounded work", () => {
  it("a 79-digit amount gives UNVERIFIED, not ALLOW (78 digits is the uint256 ceiling)", () => {
    const amount79 = "1" + "0".repeat(78);
    const response = consult(
      makeRequest({ action: { ...makeRequest().action, amount: amount79 } }),
      makePolicy()
    );
    expect(
      response.results.find((r) => r.id === "amount-within-cap")?.status
    ).to.equal("UNVERIFIED");
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("evidence strings never exceed 200 characters, even for a 2,000,000-digit amount", () => {
    const hugeAmount = "9".repeat(2_000_000);
    const response = consult(
      makeRequest({ action: { ...makeRequest().action, amount: hugeAmount } }),
      makePolicy({ perActionCaps: { pay: hugeAmount } })
    );
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
    response.results.forEach((result) => {
      expect(result.evidence.length).to.be.at.most(200);
    });
  });

  it("evidence strings never exceed 200 characters when two hostile values combine in one message", () => {
    const hostileValue = "x".repeat(10000);
    const response = consult(
      makeRequest({
        action: {
          ...makeRequest().action,
          chainId: hostileValue,
          asset: { symbol: hostileValue, contractAddress: hostileValue },
        },
      }),
      makePolicy({ chainId: hostileValue })
    );
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
    response.results.forEach((result) => {
      expect(result.evidence.length).to.be.at.most(200);
    });
  });

  it("a request whose JSON exceeds 64 KB returns UNKNOWN quickly", () => {
    const bigConditions = Array.from({ length: 100_000 }, (_, i) => `c${i}`);
    const request = { ...makeRequest(), conditions: bigConditions };

    const start = Date.now();
    const response = consult(request, makePolicy());
    const elapsed = Date.now() - start;

    expect(response.verdict).to.equal("UNKNOWN");
    expect(response.results.some((r) => r.id === "input-shape")).to.equal(true);
    expect(elapsed).to.be.lessThan(500);
  });
});

describe("consult hardening: item 5 equality checkers require well-formed values on both sides", () => {
  it("chain-matches-intent never passes when chainId is missing on both sides", () => {
    const request = makeRequest({
      action: {
        ...makeRequest().action,
        chainId: undefined as unknown as string,
      },
    });
    const response = consult(
      request,
      makePolicy({ chainId: undefined as unknown as string })
    );
    expect(
      response.results.find((r) => r.id === "chain-matches-intent")?.status
    ).to.equal("UNVERIFIED");
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("chain-matches-intent never passes on an identical but malformed CAIP-2 string", () => {
    const badChain = "EIP155:1"; // an uppercase namespace is not a well-formed CAIP-2 id
    const request = makeRequest({
      action: { ...makeRequest().action, chainId: badChain },
    });
    const response = consult(request, makePolicy({ chainId: badChain }));
    expect(
      response.results.find((r) => r.id === "chain-matches-intent")?.status
    ).to.equal("UNVERIFIED");
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("recipient-matches-policy never passes when the recipient is missing on both sides", () => {
    const request = makeRequest({
      action: {
        ...makeRequest().action,
        recipient: undefined as unknown as string,
      },
    });
    const response = consult(
      request,
      makePolicy({ approvedRecipients: [undefined as unknown as string] })
    );
    expect(
      response.results.find((r) => r.id === "recipient-matches-policy")?.status
    ).to.not.equal("PASS");
  });

  it("recipient-not-poison-derived never passes when the recipient is missing", () => {
    const request = makeRequest({
      action: {
        ...makeRequest().action,
        recipient: undefined as unknown as string,
      },
    });
    const response = consult(request, makePolicy());
    expect(
      response.results.find((r) => r.id === "recipient-not-poison-derived")
        ?.status
    ).to.not.equal("PASS");
  });

  it("asset-is-canonical never passes when the asset is missing on both sides", () => {
    const request = makeRequest({
      action: { ...makeRequest().action, asset: undefined as any },
    });
    const response = consult(request, makePolicy());
    expect(
      response.results.find((r) => r.id === "asset-is-canonical")?.status
    ).to.not.equal("PASS");
  });

  it("amount-within-cap never passes when the amount and cap are both missing", () => {
    const request = makeRequest({
      action: {
        ...makeRequest().action,
        amount: undefined as unknown as string,
      },
    });
    const response = consult(request, makePolicy({ perActionCaps: {} }));
    expect(
      response.results.find((r) => r.id === "amount-within-cap")?.status
    ).to.not.equal("PASS");
  });
});

describe("consult hardening: item 3 the catalog self-check", () => {
  it("consultWith never throws for a broken catalog; it always answers UNKNOWN naming the defect", () => {
    const brokenCheck =
      (id: string): ConditionDefinition["check"] =>
      () => ({
        id,
        status: "PASS",
        code: "TEST_PASS",
        evidenceClass: "owner-policy",
        evidence: "x",
      });
    const brokenCatalogs: Catalog[] = [
      { pay: [] },
      {
        pay: [testCondition({ id: "", isFloor: true, check: brokenCheck("") })],
      },
      {
        pay: [
          testCondition({
            id: "dup",
            isFloor: true,
            check: brokenCheck("dup"),
          }),
          testCondition({
            id: "dup",
            isFloor: true,
            check: brokenCheck("dup"),
          }),
        ],
      },
      {
        pay: [
          testCondition({
            id: "x",
            isFloor: true,
            check: "not-a-function" as any,
          }),
        ],
      },
    ];

    brokenCatalogs.forEach((catalog) => {
      expect(() => consultWith(catalog)).to.not.throw();
      const response = consultWith(catalog)(makeRequest(), makePolicy());
      expect(response.verdict).to.equal("UNKNOWN");
      expect(response.results.some((r) => r.id === "input-shape")).to.equal(
        true
      );
    });
  });

  it("consult() takes exactly the request, the policy, and facts: a caller cannot pass a fourth, catalog-shaped argument and change the outcome", () => {
    // The type system is the real enforcement (consult has no fourth
    // parameter to accept a catalog); this runtime check pins the same
    // fact for the compiled call: passing a would-be catalog as a fourth
    // argument at the JS boundary is silently ignored, never honoured.
    expect(consult.length).to.equal(3);
    const alwaysPass: ConditionDefinition = testCondition({
      id: "always-pass",
      isFloor: true,
      check: () => ({
        id: "always-pass",
        status: "PASS",
        code: "TEST_PASS",
        evidenceClass: "owner-policy",
        evidence: "x",
      }),
    });
    const poisonedRequest = makeRequest({
      action: { ...makeRequest().action, recipient: POISONED_RECIPIENT },
    });
    const response = (
      consult as unknown as (
        request: unknown,
        policy: unknown,
        facts: unknown,
        catalog: unknown
      ) => ConsultResponse
    )(poisonedRequest, makePolicy(), undefined, { pay: [alwaysPass] });
    expect(response.verdict).to.equal("DENY");
  });
});

describe("consult hardening: property test", () => {
  it("mutating any single request or policy field never throws and never yields an unearned ALLOW_UNDER_POLICY", () => {
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
          policy as unknown as Policy
        );
      }).to.not.throw();
      if (allowIsEarned) {
        expect(response?.verdict).to.equal("ALLOW_UNDER_POLICY");
      } else {
        expect(response?.verdict).to.not.equal("ALLOW_UNDER_POLICY");
      }

      // The answer-shape invariants: proceed and band are pure functions of
      // the already-decided verdict, never a second gate on it.
      expect(response?.proceed).to.equal(
        response?.verdict === "ALLOW_UNDER_POLICY"
      );
      expect(response!.support >= 0.8).to.equal(response?.proceed);
      expect(response?.band === "green").to.equal(response?.proceed);
      if (response?.results.some((r) => r.status === "FAIL")) {
        expect(response.support).to.equal(0);
      }
      if (response?.results.some((r) => r.status === "UNVERIFIED")) {
        expect(response.support).to.be.at.most(0.79);
      }
    }

    // conditions only ever ADDS non-Floor checks; undefined or an empty list
    // is exactly "no extra conditions", the same as the default request,
    // which legitimately earns ALLOW when the rest of the request is valid.
    // This is pinned as an assertion, not skipped, so the exclusion itself
    // is proven rather than assumed.
    const conditionsValueIsStillValid = (value: unknown) =>
      value === undefined || (Array.isArray(value) && value.length === 0);

    function makeGetterRequest(): unknown {
      let reads = 0;
      return {
        get action() {
          reads += 1;
          return reads === 1
            ? { ...base.action, type: "refund" }
            : { ...base.action, type: "pay" };
        },
      };
    }

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
      // A getter-based request: now that every field is read from the
      // frozen clone (item 1), this proves the general property holds for
      // an adversarial getter too, not only the one regression case above.
      { build: () => makeGetterRequest() },
    ];

    requestMutators.forEach(({ build, allowIsEarned }) => {
      MUTATIONS.forEach((value) =>
        attempt(build(value), basePolicy, allowIsEarned?.(value) ?? false)
      );
    });

    // permits: true is the base fixture's own correct value, not a
    // mutation; substituting it back in changes nothing and legitimately
    // still earns ALLOW. This is pinned as an assertion, not skipped.
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
