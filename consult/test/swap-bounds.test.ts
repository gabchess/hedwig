import { expect } from "chai";

import { consult } from "../src";
import { CATALOG, validateCatalog } from "../src/catalog";
import type { Catalog } from "../src/catalog";
import { consultWith } from "../src/internal";
import {
  makePolicy,
  makeRequest,
  makeSwapFacts,
  makeSwapPolicy,
  makeSwapRequest,
  testCondition,
} from "./fixtures";

function swapWith(
  action: Record<string, unknown>,
  policy: Record<string, unknown> = {}
) {
  return consult(
    makeSwapRequest({ action: { ...makeSwapRequest().action, ...action } }),
    makeSwapPolicy(policy),
    makeSwapFacts()
  );
}

function slippageRow(response: ReturnType<typeof consult>) {
  return response.results.find(
    (result) => result.id === "slippage-within-ceiling"
  );
}

describe("swap slippage at its edges", () => {
  it("passes when the slippage equals the ceiling exactly", () => {
    const response = swapWith(
      { quotedOut: "1000000", minOut: "990000", slippageBps: 100 },
      { maxSlippageBps: 100 }
    );
    expect(slippageRow(response)?.code).to.equal("SLIPPAGE_WITHIN_CEILING");
    expect(response.proceed).to.equal(true);
  });

  it("fails a fraction of a basis point over the ceiling", () => {
    // 100.99 bps: rounds down to 100, and is still over a ceiling of 100.
    const response = swapWith(
      { quotedOut: "1000000", minOut: "989901", slippageBps: 100 },
      { maxSlippageBps: 100 }
    );
    expect(slippageRow(response)?.code).to.equal("SLIPPAGE_EXCEEDS_CEILING");
    expect(response.proceed).to.equal(false);
    expect(response.support).to.equal(0);
  });

  it("a ceiling of zero accepts only minOut equal to quotedOut", () => {
    const quotedOut = "1000000000000000000000000000000";
    const justUnder = (BigInt(quotedOut) - 1n).toString();
    expect(
      swapWith(
        { quotedOut, minOut: justUnder, slippageBps: 0 },
        { maxSlippageBps: 0 }
      ).proceed
    ).to.equal(false);
    expect(
      swapWith(
        { quotedOut, minOut: quotedOut, slippageBps: 0 },
        { maxSlippageBps: 0 }
      ).proceed
    ).to.equal(true);
  });

  it("fails a minOut of zero even under a ceiling of 10000", () => {
    const response = swapWith(
      { minOut: "0", slippageBps: 10000 },
      { maxSlippageBps: 10000 }
    );
    expect(slippageRow(response)?.code).to.equal("SLIPPAGE_MIN_OUT_ZERO");
  });

  it("fails a minOut above the quote", () => {
    const response = swapWith({
      quotedOut: "1000000",
      minOut: "1000050",
      slippageBps: 0,
    });
    expect(slippageRow(response)?.code).to.equal(
      "SLIPPAGE_MIN_OUT_EXCEEDS_QUOTE"
    );
  });

  it("names a non-integer declared slippage as malformed", () => {
    const response = swapWith({ slippageBps: 50.5 });
    expect(slippageRow(response)?.code).to.equal("SLIPPAGE_BPS_MALFORMED");
  });

  it("cannot confirm against a ceiling above 10000", () => {
    const response = swapWith({}, { maxSlippageBps: 10001 });
    expect(slippageRow(response)?.status).to.equal("UNVERIFIED");
    expect(response.proceed).to.equal(false);
  });

  it("reports the quote as the caller's own statement, the weakest proof in a clean swap", () => {
    const response = swapWith({});
    expect(slippageRow(response)?.evidenceClass).to.equal("caller-stated");
    expect(response.proceed).to.equal(true);
    expect(response.support).to.equal(0.9);
    expect(response.band).to.equal("green");
  });
});

describe("facts that cannot be used are treated as no facts", () => {
  const UNUSABLE: Array<[string, unknown]> = [
    ["holds a function", { now: 1, f() {} }],
    ["holds a symbol", { now: Symbol("now") }],
    [
      "throws on read",
      Object.defineProperty({}, "now", {
        enumerable: true,
        get() {
          throw new Error("no");
        },
      }),
    ],
    ["is far too large", { now: 1, pad: "x".repeat(200 * 1024) }],
  ];

  UNUSABLE.forEach(([name, facts]) => {
    it(`pay is unchanged when facts ${name}`, () => {
      const response = consult(makeRequest(), makePolicy(), facts as never);
      expect(response).to.deep.equal(consult(makeRequest(), makePolicy()));
    });

    it(`swap cannot confirm its deadline when facts ${name}`, () => {
      const response = consult(
        makeSwapRequest(),
        makeSwapPolicy(),
        facts as never
      );
      const row = response.results.find(
        (result) => result.id === "deadline-set-and-fresh"
      );
      expect(row?.status).to.equal("UNVERIFIED");
      expect(response.verdict).to.equal("UNKNOWN");
    });
  });

  it("reads facts.now once and hands checkers a frozen copy", () => {
    let reads = 0;
    const facts = {
      get now() {
        reads += 1;
        return reads === 1 ? makeSwapFacts().now : 1;
      },
    };
    let seenFrozen: boolean | undefined;
    const catalog: Catalog = {
      swap: [
        ...CATALOG.swap,
        testCondition({
          id: "sees-facts",
          isFloor: false,
          check: (_request, context) => {
            seenFrozen = Object.isFrozen(
              (context as { facts?: unknown }).facts
            );
            return {
              id: "sees-facts",
              status: "PASS",
              code: "TEST_PASS",
              evidenceClass: "owner-policy",
              evidence: "n/a",
            };
          },
        }),
      ],
    };
    const response = consultWith(catalog)(
      makeSwapRequest({ conditions: ["sees-facts"] }),
      makeSwapPolicy(),
      facts as never
    );

    expect(reads).to.equal(1);
    expect(seenFrozen).to.equal(true);
    expect(response.proceed).to.equal(true);
  });
});

describe("a catalog table entry inherited from a prototype", () => {
  it("is not a declared evidence class", () => {
    const inherited = Object.create({ TEST_PASS: "owner-policy" });
    inherited.TEST_FAIL = "owner-policy";
    inherited.TEST_UNVERIFIED = "not-verifiable";
    const catalog: Catalog = {
      pay: [
        testCondition({
          id: "inherits",
          isFloor: true,
          codeEvidenceClass: inherited,
          check: () => ({
            id: "inherits",
            status: "PASS",
            code: "TEST_PASS",
            evidenceClass: "owner-policy",
            evidence: "n/a",
          }),
        }),
      ],
    };
    expect(validateCatalog(catalog)).to.be.a("string");
  });
});
