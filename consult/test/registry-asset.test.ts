import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import { consult } from "../src";
import {
  BASE_CHAIN_ID,
  BASE_USDC_ADDRESS,
  canonicalAddressFor,
} from "../src/catalog";
import type { ConsultResponse } from "../src";
import {
  ASSET_ADDRESS,
  ASSET_SYMBOL,
  CHAIN_ID,
  SWAP_NOW,
  makePolicy,
  makeRequest,
  makeSwapPolicy,
  makeSwapRequest,
} from "./fixtures";

const ETHEREUM_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const LOOKALIKE_USDT = "0x" + "7".repeat(40);
const REGISTRY_CONDITION_IDS = [
  "asset-is-canonical",
  "target-is-canonical",
  "token-in-is-canonical",
  "token-out-is-canonical",
];

function makeRegistryFact(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    chainId: CHAIN_ID,
    symbol: "USDT",
    contractAddress: ETHEREUM_USDT,
    expiresAt: SWAP_NOW + 86_400,
    liveRead: "confirmed",
    ...overrides,
  };
}

function factsWith(registryAsset: unknown): Record<string, unknown> {
  return { now: SWAP_NOW, registryAsset };
}

function usdtPayRequest(address: string) {
  return makeRequest({
    action: {
      ...makeRequest().action,
      asset: { symbol: "USDT", contractAddress: address },
      target: address,
    },
  });
}

function usdtSwapRequest(side: "tokenIn" | "tokenOut", address: string) {
  return makeSwapRequest({
    action: {
      ...makeSwapRequest().action,
      ...(side === "tokenIn"
        ? { tokenIn: { symbol: "USDT", contractAddress: address } }
        : {
            tokenIn: { symbol: ASSET_SYMBOL, contractAddress: ASSET_ADDRESS },
            tokenOut: { symbol: "USDT", contractAddress: address },
          }),
    },
  });
}

function row(response: ConsultResponse, id: string) {
  const found = response.results.find((r) => r.id === id);
  expect(found, id).to.exist;
  return found!;
}

describe("registry Fact: canonicalAddressFor", () => {
  it("answers the code-table entry, with no Fact needed", () => {
    expect(
      canonicalAddressFor(CHAIN_ID, ASSET_SYMBOL, undefined)
    ).to.deep.equal({ source: "code-table", address: ASSET_ADDRESS });
    expect(
      canonicalAddressFor(BASE_CHAIN_ID, ASSET_SYMBOL, undefined)
    ).to.deep.equal({ source: "code-table", address: BASE_USDC_ADDRESS });
  });

  it("answers a valid Fact's address when the code table has no entry", () => {
    expect(
      canonicalAddressFor(CHAIN_ID, "USDT", factsWith(makeRegistryFact()))
    ).to.deep.equal({
      source: "registry",
      address: ETHEREUM_USDT,
      liveRead: "confirmed",
    });
  });

  it("carries a mismatch or unconfirmed live read through, never upgraded", () => {
    for (const liveRead of ["mismatch", "unconfirmed"]) {
      expect(
        canonicalAddressFor(
          CHAIN_ID,
          "USDT",
          factsWith(makeRegistryFact({ liveRead }))
        )
      ).to.deep.equal({ source: "registry", address: ETHEREUM_USDT, liveRead });
    }
  });

  it("lets the code table win over a Fact for the same chain and symbol", () => {
    const fact = makeRegistryFact({
      symbol: ASSET_SYMBOL,
      contractAddress: LOOKALIKE_USDT,
    });
    expect(
      canonicalAddressFor(CHAIN_ID, ASSET_SYMBOL, factsWith(fact))
    ).to.deep.equal({ source: "code-table", address: ASSET_ADDRESS });
  });

  it("answers undefined with no Fact and no code entry", () => {
    expect(canonicalAddressFor(CHAIN_ID, "USDT", undefined)).to.equal(
      undefined
    );
    expect(canonicalAddressFor(CHAIN_ID, "USDT", { now: SWAP_NOW })).to.equal(
      undefined
    );
  });

  it("never fills a gap on a non-EVM or malformed chain id, even with a matching Fact", () => {
    for (const chainId of ["solana:mainnet", "eip155:", "eip155"]) {
      const fact = makeRegistryFact({ chainId });
      expect(
        canonicalAddressFor(chainId, "USDT", factsWith(fact)),
        chainId
      ).to.equal(undefined);
    }
  });

  it("never resolves a prototype key, with or without a Fact", () => {
    for (const key of ["constructor", "__proto__", "toString"]) {
      expect(canonicalAddressFor(CHAIN_ID, key, undefined), key).to.equal(
        undefined
      );
      expect(canonicalAddressFor(key, ASSET_SYMBOL, undefined), key).to.equal(
        undefined
      );
    }
  });
});

describe("registry Fact: pay asset-is-canonical and target-is-canonical", () => {
  it("real Ethereum USDT with a valid Fact is ALLOW_UNDER_POLICY for a plain transfer", () => {
    const response = consult(
      usdtPayRequest(ETHEREUM_USDT),
      makePolicy(),
      factsWith(makeRegistryFact())
    );
    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(response.proceed).to.equal(true);
    expect(row(response, "asset-is-canonical").code).to.equal(
      "ASSET_IS_CANONICAL"
    );
    expect(row(response, "target-is-canonical").code).to.equal(
      "TARGET_IS_CANONICAL"
    );
  });

  it("a case-folded real address still passes against the Fact", () => {
    const response = consult(
      usdtPayRequest(ETHEREUM_USDT.toLowerCase()),
      makePolicy(),
      factsWith(makeRegistryFact())
    );
    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
  });

  it("a fresh lookalike USDT is DENY with ASSET_NOT_CANONICAL and TARGET_NOT_CANONICAL", () => {
    const response = consult(
      usdtPayRequest(LOOKALIKE_USDT),
      makePolicy(),
      factsWith(makeRegistryFact())
    );
    expect(response.verdict).to.equal("DENY");
    expect(response.proceed).to.equal(false);
    expect(row(response, "asset-is-canonical")).to.include({
      status: "FAIL",
      code: "ASSET_NOT_CANONICAL",
    });
    expect(row(response, "target-is-canonical")).to.include({
      status: "FAIL",
      code: "TARGET_NOT_CANONICAL",
    });
  });

  it("no Fact and no code entry is UNKNOWN", () => {
    const response = consult(usdtPayRequest(ETHEREUM_USDT), makePolicy(), {
      now: SWAP_NOW,
    });
    expect(response.verdict).to.equal("UNKNOWN");
    expect(row(response, "asset-is-canonical").code).to.equal(
      "ASSET_REGISTRY_ENTRY_MISSING"
    );
    expect(row(response, "target-is-canonical").code).to.equal(
      "TARGET_REGISTRY_ENTRY_MISSING"
    );
  });

  const LIVE_READ_CODES: Record<string, [string, string]> = {
    mismatch: [
      "ASSET_LIVE_READ_DISAGREES_WITH_REGISTRY",
      "TARGET_LIVE_READ_DISAGREES_WITH_REGISTRY",
    ],
    unconfirmed: [
      "ASSET_IMPLEMENTATION_UNCONFIRMED",
      "TARGET_IMPLEMENTATION_UNCONFIRMED",
    ],
  };

  Object.entries(LIVE_READ_CODES).forEach(
    ([liveRead, [assetCode, targetCode]]) => {
      [ETHEREUM_USDT, LOOKALIKE_USDT].forEach((address) => {
        it(`a ${liveRead} Fact gives UNKNOWN for ${
          address === ETHEREUM_USDT ? "the real" : "a lookalike"
        } address`, () => {
          const response = consult(
            usdtPayRequest(address),
            makePolicy(),
            factsWith(makeRegistryFact({ liveRead }))
          );
          expect(response.verdict).to.equal("UNKNOWN");
          expect(response.proceed).to.equal(false);
          expect(row(response, "asset-is-canonical")).to.include({
            status: "UNVERIFIED",
            code: assetCode,
            evidenceClass: "not-verifiable",
          });
          expect(row(response, "target-is-canonical")).to.include({
            status: "UNVERIFIED",
            code: targetCode,
            evidenceClass: "not-verifiable",
          });
        });
      });
    }
  );
});

describe("registry Fact: ignored Facts are exactly no Fact", () => {
  const IGNORED: Record<string, unknown> = {
    "another symbol": makeRegistryFact({ symbol: "USDS" }),
    "a lowercase symbol": makeRegistryFact({ symbol: "usdt" }),
    "another chain": makeRegistryFact({ chainId: BASE_CHAIN_ID }),
    "a non-EVM chain": makeRegistryFact({ chainId: "solana:mainnet" }),
    "an expired row": makeRegistryFact({ expiresAt: SWAP_NOW - 1 }),
    "a row expiring at now": makeRegistryFact({ expiresAt: SWAP_NOW }),
    "a float expiresAt": makeRegistryFact({ expiresAt: SWAP_NOW + 0.5 }),
    "a string expiresAt": makeRegistryFact({ expiresAt: String(SWAP_NOW + 1) }),
    "a missing expiresAt": makeRegistryFact({ expiresAt: undefined }),
    "a malformed address": makeRegistryFact({ contractAddress: "0x1234" }),
    "a missing address": makeRegistryFact({ contractAddress: undefined }),
    "an unknown liveRead": makeRegistryFact({ liveRead: "ok" }),
    "a missing liveRead": makeRegistryFact({ liveRead: undefined }),
    "a boolean liveRead": makeRegistryFact({ liveRead: true }),
    "a non-string symbol": makeRegistryFact({ symbol: ["USDT"] }),
    "an array of Facts": [makeRegistryFact()],
    "a string": "USDT",
    null: null,
  };

  const REQUESTS = {
    "pay, real address": () => usdtPayRequest(ETHEREUM_USDT),
    "pay, lookalike address": () => usdtPayRequest(LOOKALIKE_USDT),
    "swap token-in, real address": () =>
      usdtSwapRequest("tokenIn", ETHEREUM_USDT),
    "swap token-out, lookalike address": () =>
      usdtSwapRequest("tokenOut", LOOKALIKE_USDT),
  };

  Object.entries(IGNORED).forEach(([label, fact]) => {
    Object.entries(REQUESTS).forEach(([requestLabel, build]) => {
      it(`${label} (${requestLabel})`, () => {
        const policy = requestLabel.startsWith("swap")
          ? makeSwapPolicy()
          : makePolicy();
        const withFact = consult(build(), policy, factsWith(fact));
        const without = consult(build(), policy, { now: SWAP_NOW });
        expect(JSON.stringify(withFact)).to.equal(JSON.stringify(without));
        expect(withFact.verdict).to.equal("UNKNOWN");
      });
    });
  });

  it("a valid Fact with no facts.now is ignored", () => {
    const facts = { registryAsset: makeRegistryFact() };
    const withFact = consult(
      usdtPayRequest(ETHEREUM_USDT),
      makePolicy(),
      facts
    );
    const without = consult(usdtPayRequest(ETHEREUM_USDT), makePolicy(), {});
    expect(JSON.stringify(withFact)).to.equal(JSON.stringify(without));
    expect(withFact.verdict).to.equal("UNKNOWN");
    expect(row(withFact, "asset-is-canonical").code).to.equal(
      "ASSET_REGISTRY_ENTRY_MISSING"
    );
  });
});

describe("registry Fact: the code table always wins", () => {
  const SHADOW_FACTS = ["confirmed", "mismatch", "unconfirmed"].map(
    (liveRead) =>
      makeRegistryFact({
        symbol: ASSET_SYMBOL,
        contractAddress: LOOKALIKE_USDT,
        liveRead,
      })
  );

  SHADOW_FACTS.forEach((fact) => {
    it(`a ${fact.liveRead} Fact shadowing USDC changes nothing, pay and swap`, () => {
      const lookalikeUsdc = makeRequest({
        action: {
          ...makeRequest().action,
          asset: { symbol: ASSET_SYMBOL, contractAddress: LOOKALIKE_USDT },
          target: LOOKALIKE_USDT,
        },
      });
      const cases: [unknown, unknown][] = [
        [makeRequest(), makePolicy()],
        [lookalikeUsdc, makePolicy()],
        [makeSwapRequest(), makeSwapPolicy()],
      ];
      cases.forEach(([request, policy]) => {
        const withFact = consult(
          request as never,
          policy as never,
          factsWith(fact)
        );
        const without = consult(request as never, policy as never, {
          now: SWAP_NOW,
        });
        expect(JSON.stringify(withFact)).to.equal(JSON.stringify(without));
      });
    });
  });
});

describe("registry Fact: swap token-in and token-out resolve USDT through the helper", () => {
  (["tokenIn", "tokenOut"] as const).forEach((side) => {
    const id =
      side === "tokenIn" ? "token-in-is-canonical" : "token-out-is-canonical";
    const prefix = side === "tokenIn" ? "SWAP_TOKEN_IN" : "SWAP_TOKEN_OUT";

    it(`${side}: real USDT with a valid Fact passes and the swap is ALLOW_UNDER_POLICY`, () => {
      const response = consult(
        usdtSwapRequest(side, ETHEREUM_USDT),
        makeSwapPolicy(),
        factsWith(makeRegistryFact())
      );
      expect(row(response, id)).to.include({
        status: "PASS",
        code: `${prefix}_IS_CANONICAL`,
      });
      expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    });

    it(`${side}: a lookalike USDT with a valid Fact is DENY`, () => {
      const response = consult(
        usdtSwapRequest(side, LOOKALIKE_USDT),
        makeSwapPolicy(),
        factsWith(makeRegistryFact())
      );
      expect(row(response, id)).to.include({
        status: "FAIL",
        code: `${prefix}_NOT_CANONICAL`,
      });
      expect(response.verdict).to.equal("DENY");
    });

    it(`${side}: mismatch and unconfirmed give UNKNOWN`, () => {
      const codes: Record<string, string> = {
        mismatch: `${prefix}_LIVE_READ_DISAGREES_WITH_REGISTRY`,
        unconfirmed: `${prefix}_IMPLEMENTATION_UNCONFIRMED`,
      };
      Object.entries(codes).forEach(([liveRead, code]) => {
        const response = consult(
          usdtSwapRequest(side, ETHEREUM_USDT),
          makeSwapPolicy(),
          factsWith(makeRegistryFact({ liveRead }))
        );
        expect(row(response, id), liveRead).to.include({
          status: "UNVERIFIED",
          code,
          evidenceClass: "not-verifiable",
        });
        expect(response.verdict, liveRead).to.equal("UNKNOWN");
      });
    });
  });

  it("the same-contract check still runs before the registry lookup", () => {
    const request = makeSwapRequest({
      action: {
        ...makeSwapRequest().action,
        tokenIn: { symbol: "USDT", contractAddress: ETHEREUM_USDT },
        tokenOut: { symbol: "USDT", contractAddress: ETHEREUM_USDT },
      },
    });
    const response = consult(
      request,
      makeSwapPolicy(),
      factsWith(makeRegistryFact())
    );
    expect(row(response, "token-in-is-canonical").code).to.equal(
      "SWAP_TOKEN_IN_SAME_AS_TOKEN_OUT"
    );
    expect(response.verdict).to.equal("DENY");
  });

  it("the swap router stays the router table's call, never the token Fact's", () => {
    const request = makeSwapRequest({
      action: {
        ...makeSwapRequest().action,
        tokenIn: { symbol: "USDT", contractAddress: ETHEREUM_USDT },
        target: ETHEREUM_USDT,
      },
    });
    const response = consult(
      request,
      makeSwapPolicy(),
      factsWith(makeRegistryFact())
    );
    expect(row(response, "target-is-canonical").code).to.equal(
      "SWAP_TARGET_NOT_CANONICAL"
    );
    expect(response.verdict).to.equal("DENY");
  });
});

describe("registry Fact: never turns another Condition's result into PASS", () => {
  interface CorpusEntry {
    id: string;
    request: unknown;
    policy: unknown;
    facts?: unknown;
  }
  const CORPUS: CorpusEntry[] = JSON.parse(
    readFileSync(
      join(__dirname, "fixtures", "wrong-proceed-corpus.json"),
      "utf8"
    )
  );

  function withUsdtFact(facts: unknown): unknown {
    if (facts === undefined) {
      return { registryAsset: makeRegistryFact() };
    }
    if (facts !== null && typeof facts === "object" && !Array.isArray(facts)) {
      return { ...facts, registryAsset: makeRegistryFact() };
    }
    return facts;
  }

  function usdtVariant(request: unknown): unknown {
    const action = (request as { action?: Record<string, unknown> }).action;
    if (action === null || typeof action !== "object") {
      return request;
    }
    const usdt = { symbol: "USDT", contractAddress: ETHEREUM_USDT };
    return {
      ...(request as object),
      action:
        "tokenIn" in action
          ? { ...action, tokenIn: usdt }
          : { ...action, asset: usdt, target: ETHEREUM_USDT },
    };
  }

  it("every non-registry row is identical with and without a valid Fact, across the corpus and its USDT variants", () => {
    let compared = 0;
    CORPUS.forEach((entry) => {
      [entry.request, usdtVariant(entry.request)].forEach((request) => {
        const facts = withUsdtFact(entry.facts);
        const withFact = consult(
          request as never,
          entry.policy as never,
          facts
        );
        const without = consult(
          request as never,
          entry.policy as never,
          entry.facts
        );
        const others = (response: ConsultResponse) =>
          response.results.filter(
            (r) => !REGISTRY_CONDITION_IDS.includes(r.id)
          );
        expect(others(withFact), entry.id).to.deep.equal(others(without));
        compared += others(without).length;
        if (without.verdict === "DENY") {
          expect(withFact.verdict, entry.id).to.equal("DENY");
        }
      });
    });
    expect(compared).to.be.greaterThan(500);
  });

  it("a Fact alone cannot lift a request whose other Conditions fail", () => {
    const request = usdtPayRequest(ETHEREUM_USDT);
    const response = consult(
      {
        action: {
          ...request.action,
          recipient: "0x00000000000000000000000000000000badc0de0",
        },
      },
      makePolicy(),
      factsWith(makeRegistryFact())
    );
    expect(row(response, "asset-is-canonical").status).to.equal("PASS");
    expect(row(response, "recipient-matches-policy").status).to.equal("FAIL");
    expect(response.verdict).to.equal("DENY");
  });
});
