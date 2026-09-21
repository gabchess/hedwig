import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import { consult, type Catalog, type ConditionDefinition } from "../src";
import { PAY_CATALOG } from "../src/catalog";
import {
  APPROVED_RECIPIENT,
  ASSET_ADDRESS,
  CATALOG_WITH_EXTRA_CONDITION,
  PASSING_EXTRA_CONDITION_ID,
  POISONED_RECIPIENT,
  UNAPPROVED_RECIPIENT,
  makePolicy,
  makeRequest,
} from "./fixtures";

const FLOOR_IDS = [
  "recipient-matches-policy",
  "recipient-not-poison-derived",
  "asset-is-canonical",
  "amount-within-cap",
  "chain-matches-intent",
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
    const response = consult(makeRequest(), PAY_CATALOG, makePolicy());

    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(response.advisory).to.equal(true);
    expect(response.floorIds).to.have.members(FLOOR_IDS);
    expect(response.results).to.have.length(5);
    response.results.forEach((result) => {
      expect(result.status).to.equal("PASS");
      expect(result.evidence).to.be.a("string").that.is.not.empty;
    });
  });

  it("returns DENY when one Condition fails, whatever the others say", () => {
    const request = makeRequest({
      action: { ...makeRequest().action, recipient: UNAPPROVED_RECIPIENT },
    });
    const response = consult(request, PAY_CATALOG, makePolicy());

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
      PAY_CATALOG,
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
    const response = consult(request, PAY_CATALOG, makePolicy());

    expect(response.verdict).to.equal("UNKNOWN");
    const unverified = response.results.find(
      (result) => result.id === "asset-is-canonical"
    );
    expect(unverified?.status).to.equal("UNVERIFIED");

    const requestWithExtraPass = {
      ...request,
      conditions: [PASSING_EXTRA_CONDITION_ID],
    };
    const responseWithExtraPass = consult(
      requestWithExtraPass,
      CATALOG_WITH_EXTRA_CONDITION,
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
    const response = consult(request, PAY_CATALOG, makePolicy());

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
      const response = consult(shape as any, PAY_CATALOG, makePolicy());
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
      action: { ...makeRequest().action, type: "swap" },
    });
    const response = consult(request, PAY_CATALOG, makePolicy());

    expect(response.verdict).to.equal("UNKNOWN");
    expect(response.floorIds).to.deep.equal([]);
    expect(
      response.results.some((result) => result.status === "PASS")
    ).to.equal(false);
    expect(
      response.results.some((result) => result.evidence.includes("swap"))
    ).to.equal(true);
  });

  it("returns UNVERIFIED for a Condition id the catalog does not know", () => {
    const request = { ...makeRequest(), conditions: ["not-a-real-condition"] };
    const response = consult(request, PAY_CATALOG, makePolicy());

    expect(response.verdict).to.equal("UNKNOWN");
    const unknown = response.results.find(
      (result) => result.id === "not-a-real-condition"
    );
    expect(unknown?.status).to.equal("UNVERIFIED");
  });

  it("treats a throwing checker as UNVERIFIED without crashing consult", () => {
    const throwingCondition: ConditionDefinition = {
      id: "throws-on-check",
      isFloor: false,
      check: () => {
        throw new TypeError("boom");
      },
    };
    const catalog: Catalog = {
      pay: [...PAY_CATALOG.pay, throwingCondition],
    };
    const request = { ...makeRequest(), conditions: ["throws-on-check"] };

    const response = consult(request, catalog, makePolicy());

    const result = response.results.find(
      (item) => item.id === "throws-on-check"
    );
    expect(result?.status).to.equal("UNVERIFIED");
    expect(result?.evidence).to.include("TypeError");
  });

  it("compares amounts as bigints, correct above Number.MAX_SAFE_INTEGER", () => {
    const atCap = consult(
      makeRequest({ action: { ...makeRequest().action, amount: "1000000" } }),
      PAY_CATALOG,
      makePolicy()
    );
    expect(
      atCap.results.find((r) => r.id === "amount-within-cap")?.status
    ).to.equal("PASS");

    const overCap = consult(
      makeRequest({ action: { ...makeRequest().action, amount: "1000001" } }),
      PAY_CATALOG,
      makePolicy()
    );
    expect(
      overCap.results.find((r) => r.id === "amount-within-cap")?.status
    ).to.equal("FAIL");

    const bigCap = "9007199254740993"; // Number.MAX_SAFE_INTEGER + 2
    const atBigCap = consult(
      makeRequest({ action: { ...makeRequest().action, amount: bigCap } }),
      PAY_CATALOG,
      makePolicy({ perActionCaps: { pay: bigCap } })
    );
    expect(
      atBigCap.results.find((r) => r.id === "amount-within-cap")?.status
    ).to.equal("PASS");

    const overBigCap = consult(
      makeRequest({
        action: { ...makeRequest().action, amount: "9007199254740994" },
      }),
      PAY_CATALOG,
      makePolicy({ perActionCaps: { pay: bigCap } })
    );
    expect(
      overBigCap.results.find((r) => r.id === "amount-within-cap")?.status
    ).to.equal("FAIL");
  });

  it("compares the recipient byte-exact, not case-folded or fuzzy", () => {
    // recipient-matches-policy uses strict string equality (Array#includes),
    // so no case-folding or address checksum normalisation is applied: the
    // Floor requires an exact match against an owner-approved entry.
    const caseVariant = "0x" + APPROVED_RECIPIENT.slice(2).toUpperCase();
    const lookalike =
      APPROVED_RECIPIENT.slice(0, 6) +
      "9".repeat(APPROVED_RECIPIENT.length - 10) +
      APPROVED_RECIPIENT.slice(-4);

    [caseVariant, lookalike].forEach((recipient) => {
      const response = consult(
        makeRequest({ action: { ...makeRequest().action, recipient } }),
        PAY_CATALOG,
        makePolicy()
      );
      expect(
        response.results.find((r) => r.id === "recipient-matches-policy")
          ?.status
      ).to.equal("FAIL");
    });
  });

  it("is pure: same input twice gives deep-equal output and never mutates its input", () => {
    const request = deepFreeze(makeRequest());
    const policy = deepFreeze(makePolicy());

    const first = consult(request, PAY_CATALOG, policy);
    const second = consult(request, PAY_CATALOG, policy);

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
