import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import { consult } from "../src";
import type { Catalog, ConditionDefinition } from "../src/catalog";
import { PAY_CATALOG } from "../src/catalog";
import { consultWith } from "../src/internal";
import {
  APPROVED_RECIPIENT,
  ASSET_ADDRESS,
  CATALOG_WITH_EXTRA_CONDITION,
  PASSING_EXTRA_CONDITION_ID,
  POISONED_RECIPIENT,
  UNAPPROVED_RECIPIENT,
  makePolicy,
  makeRequest,
  testCondition,
} from "./fixtures";

const FLOOR_IDS = [
  "recipient-matches-policy",
  "recipient-not-poison-derived",
  "asset-is-canonical",
  "amount-within-cap",
  "chain-matches-intent",
  "target-is-canonical",
  "role-requirement-met",
  "authorization-window-within-ceiling",
];

function deepFreeze<T>(value: T): T {
  Object.getOwnPropertyNames(value as object).forEach((key) => {
    const child = (value as Record<string, unknown>)[key];
    if (child !== null && typeof child === "object") {
      deepFreeze(child);
    }
  });
  return Object.freeze(value);
}

describe("consult", () => {
  it("returns ALLOW_UNDER_POLICY when every Floor Condition passes and the Policy permits", () => {
    const response = consult(makeRequest(), makePolicy());

    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(response.proceed).to.equal(true);
    expect(response.question).to.equal(
      "Should this agent proceed with this payment under the owner's policy?"
    );
    // Pinned worked value: five owner-policy (0.9) and three
    // static-registry (0.6) PASS rows, so the weakest is still 0.6 and
    // support = 0.80 + 0.20 * 0.6 = 0.92. role-requirement-met and
    // authorization-window-within-ceiling each add one more owner-policy
    // row (ROLE_NOT_REQUIRED, AUTHORIZATION_NOT_REQUIRED), which does not
    // move the weakest weight.
    expect(response.support).to.equal(0.92);
    expect(response.band).to.equal("green");
    expect(response.advisory).to.equal(true);
    expect(response.floorIds).to.have.members(FLOOR_IDS);
    expect(response.results).to.have.length(8);
    response.results.forEach((result) => {
      expect(result.status).to.equal("PASS");
      expect(result.evidence).to.be.a("string").that.is.not.empty;
      expect(result.question).to.be.a("string").that.is.not.empty;
      expect(result.code).to.be.a("string").that.is.not.empty;
      expect(result.reference).to.be.a("string").that.is.not.empty;
      expect(["onchain-read", "owner-policy", "static-registry"]).to.include(
        result.evidenceClass
      );
    });
  });

  it("returns DENY when one Condition fails, whatever the others say", () => {
    const request = makeRequest({
      action: { ...makeRequest().action, recipient: UNAPPROVED_RECIPIENT },
    });
    const response = consult(request, makePolicy());

    expect(response.verdict).to.equal("DENY");
    const failing = response.results.find(
      (result) => result.id === "recipient-matches-policy"
    );
    expect(failing?.status).to.equal("FAIL");
  });

  it("flags a recipient first seen through a poison transfer", () => {
    const request = makeRequest({
      action: { ...makeRequest().action, recipient: POISONED_RECIPIENT },
    });
    const response = consult(
      request,
      makePolicy({ approvedRecipients: [POISONED_RECIPIENT] })
    );

    expect(response.verdict).to.equal("DENY");
    const failing = response.results.find(
      (result) => result.id === "recipient-not-poison-derived"
    );
    expect(failing?.status).to.equal("FAIL");
  });

  it("returns UNKNOWN when a Condition cannot be checked, and no number of passes overrides it", () => {
    const request = makeRequest({
      action: {
        ...makeRequest().action,
        asset: { symbol: "USDT", contractAddress: ASSET_ADDRESS },
      },
    });
    const response = consult(request, makePolicy());

    expect(response.verdict).to.equal("UNKNOWN");
    const unverified = response.results.find(
      (result) => result.id === "asset-is-canonical"
    );
    expect(unverified?.status).to.equal("UNVERIFIED");

    const requestWithExtraPass = {
      ...request,
      conditions: [PASSING_EXTRA_CONDITION_ID],
    };
    const responseWithExtraPass = consultWith(CATALOG_WITH_EXTRA_CONDITION)(
      requestWithExtraPass,
      makePolicy()
    );
    expect(responseWithExtraPass.verdict).to.equal("UNKNOWN");
  });

  it("lets FAIL beat UNVERIFIED", () => {
    const request = makeRequest({
      action: {
        ...makeRequest().action,
        recipient: UNAPPROVED_RECIPIENT,
        asset: { symbol: "USDT", contractAddress: ASSET_ADDRESS },
      },
    });
    const response = consult(request, makePolicy());

    expect(response.verdict).to.equal("DENY");
  });

  it("never lets the request shrink the Floor", () => {
    const base = makeRequest();
    const shapes: unknown[] = [
      { ...base, conditions: undefined },
      { ...base, conditions: ["recipient-matches-policy"] },
      { ...base, conditions: [] },
      { ...base, skipFloor: true, floor: [], conditions: null } as any,
    ];

    shapes.forEach((shape) => {
      const response = consult(shape as any, makePolicy());
      expect(response.floorIds).to.have.members(FLOOR_IDS);
      FLOOR_IDS.forEach((id) => {
        expect(response.results.some((result) => result.id === id)).to.equal(
          true
        );
      });
    });
  });

  it("returns UNKNOWN with a named reason for an unknown action type, inventing zero passes", () => {
    const request = makeRequest({
      action: { ...makeRequest().action, type: "teleport" },
    });
    const response = consult(request, makePolicy());

    expect(response.verdict).to.equal("UNKNOWN");
    expect(response.floorIds).to.deep.equal([]);
    expect(
      response.results.some((result) => result.status === "PASS")
    ).to.equal(false);
    expect(
      response.results.some((result) => result.evidence.includes("teleport"))
    ).to.equal(true);
  });

  it("returns UNVERIFIED for a Condition id the catalog does not know", () => {
    const request = { ...makeRequest(), conditions: ["not-a-real-condition"] };
    const response = consult(request, makePolicy());

    expect(response.verdict).to.equal("UNKNOWN");
    const unknown = response.results.find(
      (result) => result.id === "not-a-real-condition"
    );
    expect(unknown?.status).to.equal("UNVERIFIED");
  });

  it("treats a throwing checker as UNVERIFIED without crashing consult", () => {
    const throwingCondition: ConditionDefinition = testCondition({
      id: "throws-on-check",
      isFloor: false,
      check: () => {
        throw new TypeError("boom");
      },
    });
    const catalog: Catalog = {
      pay: [...PAY_CATALOG.pay, throwingCondition],
    };
    const request = { ...makeRequest(), conditions: ["throws-on-check"] };

    const response = consultWith(catalog)(request, makePolicy());

    const result = response.results.find(
      (item) => item.id === "throws-on-check"
    );
    expect(result?.status).to.equal("UNVERIFIED");
    expect(result?.evidence).to.include("TypeError");
  });

  it("compares amounts as bigints, correct above Number.MAX_SAFE_INTEGER", () => {
    const atCap = consult(
      makeRequest({ action: { ...makeRequest().action, amount: "1000000" } }),
      makePolicy()
    );
    expect(
      atCap.results.find((r) => r.id === "amount-within-cap")?.status
    ).to.equal("PASS");
    expect(atCap.verdict).to.equal("ALLOW_UNDER_POLICY");

    const overCap = consult(
      makeRequest({ action: { ...makeRequest().action, amount: "1000001" } }),
      makePolicy()
    );
    expect(
      overCap.results.find((r) => r.id === "amount-within-cap")?.status
    ).to.equal("FAIL");
    expect(overCap.verdict).to.equal("DENY");

    const bigCap = "9007199254740993"; // Number.MAX_SAFE_INTEGER + 2
    const atBigCap = consult(
      makeRequest({ action: { ...makeRequest().action, amount: bigCap } }),
      makePolicy({ perActionCaps: { pay: bigCap } })
    );
    expect(
      atBigCap.results.find((r) => r.id === "amount-within-cap")?.status
    ).to.equal("PASS");
    expect(atBigCap.verdict).to.equal("ALLOW_UNDER_POLICY");

    const overBigCap = consult(
      makeRequest({
        action: { ...makeRequest().action, amount: "9007199254740994" },
      }),
      makePolicy({ perActionCaps: { pay: bigCap } })
    );
    expect(
      overBigCap.results.find((r) => r.id === "amount-within-cap")?.status
    ).to.equal("FAIL");
    expect(overBigCap.verdict).to.equal("DENY");
  });

  it("compares the recipient by value, folding hex-digit case but never a lookalike", () => {
    // An EVM address is its 20 raw bytes; hex-digit case only carries an
    // optional checksum encoding, so a case variant of an approved address
    // is the same recipient and must pass. A lookalike differs in its
    // actual hex digits (only the first and last four characters match)
    // and must still fail.
    const caseVariant = "0x" + APPROVED_RECIPIENT.slice(2).toUpperCase();
    const lookalike =
      APPROVED_RECIPIENT.slice(0, 6) +
      "9".repeat(APPROVED_RECIPIENT.length - 10) +
      APPROVED_RECIPIENT.slice(-4);

    const caseResponse = consult(
      makeRequest({
        action: { ...makeRequest().action, recipient: caseVariant },
      }),
      makePolicy()
    );
    expect(
      caseResponse.results.find((r) => r.id === "recipient-matches-policy")
        ?.status
    ).to.equal("PASS");

    const lookalikeResponse = consult(
      makeRequest({
        action: { ...makeRequest().action, recipient: lookalike },
      }),
      makePolicy()
    );
    expect(
      lookalikeResponse.results.find((r) => r.id === "recipient-matches-policy")
        ?.status
    ).to.equal("FAIL");
  });

  it("is pure: same input twice gives deep-equal output and never mutates its input", () => {
    const request = deepFreeze(makeRequest());
    const policy = deepFreeze(makePolicy());

    const first = consult(request, policy);
    const second = consult(request, policy);

    expect(first).to.deep.equal(second);
  });

  it("never references a network primitive from the source", () => {
    const srcDir = join(__dirname, "..", "src");
    const banned = [
      "fetch(",
      'require("http',
      'require("https',
      'require("net',
      "RpcClient",
      "node:http",
      "node:https",
      "node:net",
      "Date.now",
      "new Date",
      "Math.random",
    ];

    readdirSync(srcDir)
      .filter((file) => file.endsWith(".ts"))
      .forEach((file) => {
        const contents = readFileSync(join(srcDir, file), "utf8");
        banned.forEach((token) => {
          expect(contents).to.not.include(token);
        });
      });
  });
});
