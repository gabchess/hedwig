import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import { consult } from "../src";
import {
  makePolicy,
  makeRequest,
  makeSwapFacts,
  makeSwapPolicy,
  makeSwapRequest,
} from "./fixtures";

interface BaselineCase {
  id: string;
  request: unknown;
  policy: unknown;
  facts?: unknown;
}

const ETHEREUM_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const LOOKALIKE_USDT = "0x" + "7".repeat(40);

function usdtPayRequest(address: string): unknown {
  return makeRequest({
    action: {
      ...makeRequest().action,
      asset: { symbol: "USDT", contractAddress: address },
      target: address,
    },
  });
}

function usdtSwapRequest(address: string): unknown {
  return makeSwapRequest({
    action: {
      ...makeSwapRequest().action,
      tokenIn: { symbol: "USDT", contractAddress: address },
    },
  });
}

// Every wrong-proceed corpus row plus the shared fixture defaults and the
// USDT requests a registry Fact is meant to change. None carries a registry
// Fact. H1 adds binding diagnostics; every pre-existing diagnostic remains
// byte-identical to the recorded response, including evidence and ordering.
export function baselineCases(): BaselineCase[] {
  const corpus: BaselineCase[] = JSON.parse(
    readFileSync(
      join(__dirname, "fixtures", "wrong-proceed-corpus.json"),
      "utf8"
    )
  );
  return [
    ...corpus.map(({ id, request, policy, facts }) => ({
      id: `corpus:${id}`,
      request,
      policy,
      facts,
    })),
    { id: "fixture:pay-default", request: makeRequest(), policy: makePolicy() },
    {
      id: "fixture:swap-default",
      request: makeSwapRequest(),
      policy: makeSwapPolicy(),
      facts: makeSwapFacts(),
    },
    {
      id: "fixture:pay-usdt-ethereum-address",
      request: usdtPayRequest(ETHEREUM_USDT),
      policy: makePolicy({ perActionCapAssets: { pay: ETHEREUM_USDT } }),
      facts: makeSwapFacts(),
    },
    {
      id: "fixture:pay-usdt-lookalike-address",
      request: usdtPayRequest(LOOKALIKE_USDT),
      policy: makePolicy({ perActionCapAssets: { pay: LOOKALIKE_USDT } }),
      facts: makeSwapFacts(),
    },
    {
      id: "fixture:swap-usdt-ethereum-address",
      request: usdtSwapRequest(ETHEREUM_USDT),
      policy: makeSwapPolicy({ perActionCapAssets: { swap: ETHEREUM_USDT } }),
      facts: makeSwapFacts(),
    },
    {
      id: "fixture:swap-usdt-lookalike-address",
      request: usdtSwapRequest(LOOKALIKE_USDT),
      policy: makeSwapPolicy({ perActionCapAssets: { swap: LOOKALIKE_USDT } }),
      facts: makeSwapFacts(),
    },
  ];
}

// Recorded once from main (929ce4c), before the registry Fact existed, and
// re-recorded once when the three market-signal Conditions joined the pay
// Floor: each pay response gained their three rows, and `support` moved
// only through them. No verdict or `proceed` changed. A failure here means
// a pre-existing diagnostic changed its answer: fix the code, never re-record
// this file to make the test pass. H1's new binding row has separate tests.
const BASELINE: Record<string, unknown> = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures", "no-registry-fact-baseline.json"),
    "utf8"
  )
);

describe("no registry Fact: existing diagnostics preserve the recorded baseline", () => {
  it("covers every corpus row and fixture case, and nothing else", () => {
    expect(Object.keys(BASELINE)).to.deep.equal(
      baselineCases().map((entry) => entry.id)
    );
  });

  baselineCases().forEach(({ id, request, policy, facts }) => {
    it(id, () => {
      const response = consult(request as never, policy as never, facts);
      const baseline = BASELINE[id] as ReturnType<typeof consult>;
      if (baseline.floorIds.length === 0) {
        expect(JSON.stringify(response)).to.equal(JSON.stringify(baseline));
        return;
      }
      expect(
        JSON.stringify(
          response.results.filter((r) => r.id !== "transaction-matches-intent")
        )
      ).to.equal(JSON.stringify(baseline.results));
      expect(response.floorIds).to.deep.equal([
        ...baseline.floorIds,
        "transaction-matches-intent",
      ]);
      expect(response.question).to.equal(baseline.question);
      expect(response.advisory).to.equal(true);
      const bind = response.results.find(
        (r) => r.id === "transaction-matches-intent"
      )!;
      expect(bind).to.exist;
      const expectedVerdict =
        baseline.verdict === "DENY" || bind.status === "FAIL"
          ? "DENY"
          : baseline.verdict === "ALLOW_UNDER_POLICY" && bind.status === "PASS"
          ? "ALLOW_UNDER_POLICY"
          : "UNKNOWN";
      expect(response.verdict).to.equal(expectedVerdict);
      expect(response.proceed).to.equal(
        expectedVerdict === "ALLOW_UNDER_POLICY"
      );
      if (expectedVerdict === "DENY") expect(response.support).to.equal(0);
      else if (expectedVerdict === "ALLOW_UNDER_POLICY")
        expect(response.support).to.equal(0.9);
      else expect(response.support).to.be.lessThan(0.8);
    });
  });
});
