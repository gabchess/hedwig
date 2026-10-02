import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import { consult } from "../src";
import {
  BASE_CHAIN_ID,
  BASE_USDC_ADDRESS,
  canonicalAddressFor,
} from "../src/catalog";
import {
  MAX_REGISTRY_LIVE_READ_AGE_SECONDS,
  MAX_ROLE_FACT_AGE_SECONDS,
} from "../src/constants";
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
    liveReadAt: SWAP_NOW,
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
      it(`a ${liveRead} Fact gives UNKNOWN for the real address`, () => {
        const response = consult(
          usdtPayRequest(ETHEREUM_USDT),
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

      it(`a ${liveRead} Fact still gives DENY for a lookalike address`, () => {
        const response = consult(
          usdtPayRequest(LOOKALIKE_USDT),
          makePolicy(),
          factsWith(makeRegistryFact({ liveRead }))
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
    }
  );

  it("a malformed asset address with an unconfirmed Fact is the malformed code, not the live-read code", () => {
    const request = makeRequest({
      action: {
        ...makeRequest().action,
        asset: { symbol: "USDT", contractAddress: "0x1234" },
        target: ETHEREUM_USDT,
      },
    });
    const response = consult(
      request,
      makePolicy(),
      factsWith(makeRegistryFact({ liveRead: "unconfirmed" }))
    );
    expect(row(response, "asset-is-canonical")).to.include({
      status: "UNVERIFIED",
      code: "ASSET_ADDRESS_MALFORMED",
    });
  });
});

describe("registry Fact: liveReadAt age", () => {
  const STALE = SWAP_NOW - MAX_REGISTRY_LIVE_READ_AGE_SECONDS - 1;
  const FUTURE = SWAP_NOW + 1;

  [
    ["stale", STALE],
    ["future-dated", FUTURE],
  ].forEach(([label, liveReadAt]) => {
    it(`a ${label} confirmed read at the real address gives UNKNOWN with *_IMPLEMENTATION_UNCONFIRMED`, () => {
      const fact = makeRegistryFact({ liveReadAt });
      const pay = consult(
        usdtPayRequest(ETHEREUM_USDT),
        makePolicy(),
        factsWith(fact)
      );
      expect(pay.verdict).to.equal("UNKNOWN");
      expect(row(pay, "asset-is-canonical")).to.include({
        status: "UNVERIFIED",
        code: "ASSET_IMPLEMENTATION_UNCONFIRMED",
      });
      expect(row(pay, "target-is-canonical")).to.include({
        status: "UNVERIFIED",
        code: "TARGET_IMPLEMENTATION_UNCONFIRMED",
      });
      (["tokenIn", "tokenOut"] as const).forEach((side) => {
        const swap = consult(
          usdtSwapRequest(side, ETHEREUM_USDT),
          makeSwapPolicy(),
          factsWith(fact)
        );
        const id =
          side === "tokenIn"
            ? "token-in-is-canonical"
            : "token-out-is-canonical";
        const prefix = side === "tokenIn" ? "SWAP_TOKEN_IN" : "SWAP_TOKEN_OUT";
        expect(row(swap, id), side).to.include({
          status: "UNVERIFIED",
          code: `${prefix}_IMPLEMENTATION_UNCONFIRMED`,
        });
        expect(swap.verdict, side).to.equal("UNKNOWN");
      });
    });

    it(`a ${label} confirmed read at a lookalike address gives DENY`, () => {
      const response = consult(
        usdtPayRequest(LOOKALIKE_USDT),
        makePolicy(),
        factsWith(makeRegistryFact({ liveReadAt }))
      );
      expect(response.verdict).to.equal("DENY");
      expect(row(response, "asset-is-canonical").code).to.equal(
        "ASSET_NOT_CANONICAL"
      );
    });
  });

  it("canonicalAddressFor reports a stale confirmed read as unconfirmed and leaves a stale mismatch as mismatch", () => {
    expect(
      canonicalAddressFor(
        CHAIN_ID,
        "USDT",
        factsWith(makeRegistryFact({ liveReadAt: STALE }))
      )
    ).to.deep.equal({
      source: "registry",
      address: ETHEREUM_USDT,
      liveRead: "unconfirmed",
    });
    expect(
      canonicalAddressFor(
        CHAIN_ID,
        "USDT",
        factsWith(makeRegistryFact({ liveReadAt: STALE, liveRead: "mismatch" }))
      )
    ).to.deep.equal({
      source: "registry",
      address: ETHEREUM_USDT,
      liveRead: "mismatch",
    });
  });

  it("a confirmed read exactly at the age limit still counts as confirmed", () => {
    const response = consult(
      usdtPayRequest(ETHEREUM_USDT),
      makePolicy(),
      factsWith(
        makeRegistryFact({
          liveReadAt: SWAP_NOW - MAX_REGISTRY_LIVE_READ_AGE_SECONDS,
        })
      )
    );
    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
  });

  it("uses the same 60-second ceiling as the role fact", () => {
    expect(MAX_REGISTRY_LIVE_READ_AGE_SECONDS).to.equal(60);
    expect(MAX_REGISTRY_LIVE_READ_AGE_SECONDS).to.equal(
      MAX_ROLE_FACT_AGE_SECONDS
    );
  });
});

describe("registry Fact: symbol shape", () => {
  // The first three spellings would otherwise dodge the code table's exact
  // lookup and let a Fact vouch for a lookalike contract under a familiar
  // name. A Fact symbol is ASCII uppercase letters and digits only.
  ["usdc", "weth", "USDC\u200b", "USD-T"].forEach((symbol) => {
    it(`a Fact for ${JSON.stringify(symbol)} is ignored, never ALLOW`, () => {
      const request = makeRequest({
        action: {
          ...makeRequest().action,
          asset: { symbol, contractAddress: LOOKALIKE_USDT },
          target: LOOKALIKE_USDT,
        },
      });
      const fact = makeRegistryFact({
        symbol,
        contractAddress: LOOKALIKE_USDT,
      });
      expect(canonicalAddressFor(CHAIN_ID, symbol, factsWith(fact))).to.equal(
        undefined
      );
      const withFact = consult(request, makePolicy(), factsWith(fact));
      const without = consult(request, makePolicy(), { now: SWAP_NOW });
      expect(JSON.stringify(withFact)).to.equal(JSON.stringify(without));
      expect(withFact.verdict).to.equal("UNKNOWN");
      expect(row(withFact, "asset-is-canonical").code).to.equal(
        "ASSET_REGISTRY_ENTRY_MISSING"
      );
    });
  });
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
    "a missing liveReadAt": makeRegistryFact({ liveReadAt: undefined }),
    "a float liveReadAt": makeRegistryFact({ liveReadAt: SWAP_NOW - 0.5 }),
    "a string liveReadAt": makeRegistryFact({ liveReadAt: String(SWAP_NOW) }),
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

    it(`${side}: a lookalike with a mismatch or unconfirmed Fact is still DENY`, () => {
      ["mismatch", "unconfirmed"].forEach((liveRead) => {
        const response = consult(
          usdtSwapRequest(side, LOOKALIKE_USDT),
          makeSwapPolicy(),
          factsWith(makeRegistryFact({ liveRead }))
        );
        expect(row(response, id), liveRead).to.include({
          status: "FAIL",
          code: `${prefix}_NOT_CANONICAL`,
        });
        expect(response.verdict, liveRead).to.equal("DENY");
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

  // The no-Fact side of the comparison: a row with no usable facts.now
  // gets one, so the Fact on the other side is dated and actually read.
  function withNow(facts: unknown): unknown {
    if (facts === undefined || facts === null) {
      return { now: SWAP_NOW };
    }
    if (typeof facts === "object" && !Array.isArray(facts)) {
      const now = (facts as { now?: unknown }).now;
      return typeof now === "number" ? facts : { ...facts, now: SWAP_NOW };
    }
    return facts;
  }

  // A valid USDT Fact for the request's own chain, dated against the row's
  // own facts.now.
  function withUsdtFact(facts: unknown, request: unknown): unknown {
    if (facts === null || typeof facts !== "object" || Array.isArray(facts)) {
      return facts;
    }
    const now = (facts as { now: number }).now;
    const chainId = (request as { action?: { chainId?: unknown } }).action
      ?.chainId;
    return {
      ...facts,
      registryAsset: makeRegistryFact({
        chainId: typeof chainId === "string" ? chainId : CHAIN_ID,
        expiresAt: now + 86_400,
        liveReadAt: now,
      }),
    };
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
    let factRead = 0;
    CORPUS.forEach((entry) => {
      [entry.request, usdtVariant(entry.request)].forEach((request) => {
        const baseFacts = withNow(entry.facts);
        const facts = withUsdtFact(baseFacts, request);
        const chainId = (request as { action?: { chainId?: unknown } }).action
          ?.chainId;
        if (
          canonicalAddressFor(chainId, "USDT", facts)?.source === "registry"
        ) {
          factRead += 1;
        }
        const withFact = consult(
          request as never,
          entry.policy as never,
          facts
        );
        const without = consult(
          request as never,
          entry.policy as never,
          baseFacts
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
    // 71 rows, each with its USDT variant, is 142 requests. The only 6 that
    // never read the Fact come from the three rows built to break the clock
    // or the chain on purpose: swap-facts-now-zero, swap-facts-array and
    // swap-prototype-key-chain-id. None is skipped for lack of facts.now.
    expect(factRead).to.equal(136);
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
