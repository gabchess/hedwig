import { expect } from "chai";

import { consult, consultFloor, consultWithFloor } from "../src";
import { CATALOG, POLICY_READING_CONDITION_IDS } from "../src/catalog";
import type { ConsultRequest, Policy } from "../src/catalog";
import { FLOOR_PROFILE } from "../src/floor-profile";
import { SLIPPAGE_MEV_PARAMS_ID } from "../src/params";
import {
  CHAIN_ID,
  makePolicy,
  makeRequest,
  makeSwapPolicy,
  makeSwapRequest,
} from "./fixtures";
import {
  BASE_CHAIN_ID,
  BRIDGED_USDT,
  CAP,
  ETHEREUM_USDT,
  FAKE_USDT,
  NONE,
  NOW,
  SLIPPAGE_FILE,
  SLIPPAGE_ID,
  TAX_ID,
  THIN_TOKEN,
  UNLISTED_TOKEN,
  USDC_TAX,
  WETH_TAX,
  floorBundle,
  healthySignals,
  payOf,
  row,
  swapAt,
  swapFacts,
  swapOf,
  thinSignals,
  usdtRegistryFact,
  withoutConstant,
} from "./floor-fixtures";

function payFacts(extra: Record<string, unknown> = {}) {
  return { now: NOW, params: floorBundle(), ...extra };
}

describe("floor profile: a pay with no policy", () => {
  it("a real Ethereum USDT pay is ALLOW_UNDER_POLICY, and no owner-layer row runs", () => {
    const response = consultFloor(
      payOf("USDT", ETHEREUM_USDT),
      payFacts({ registryAsset: usdtRegistryFact() })
    );
    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(response.proceed).to.equal(true);
    expect(response.band).to.equal("green");
    expect(response.floorIds).to.deep.equal([
      "recipient-not-poison-derived",
      "asset-is-canonical",
      "target-is-canonical",
      "asset-liquidity-sufficient",
      "asset-holders-sufficient",
      "asset-activity-sufficient",
    ]);
  });

  it("a fresh fake USDT at another address is DENY", () => {
    const response = consultFloor(
      payOf("USDT", FAKE_USDT),
      payFacts({ registryAsset: usdtRegistryFact() })
    );
    expect(response.verdict).to.equal("DENY");
    expect(row(response, "asset-is-canonical").code).to.equal(
      "ASSET_NOT_CANONICAL"
    );
  });

  it("a thin unknown token is DENY", () => {
    const response = consultFloor(
      payOf("THIN", THIN_TOKEN),
      payFacts({ marketSignals: thinSignals(CHAIN_ID, THIN_TOKEN) })
    );
    expect(response.verdict).to.equal("DENY");
    expect(row(response, "asset-liquidity-sufficient").status).to.equal("FAIL");
  });

  it("Base's bridged USDT is UNKNOWN, whatever the market reads", () => {
    const response = consultFloor(
      payOf("USDT", BRIDGED_USDT, BASE_CHAIN_ID),
      payFacts({ marketSignals: healthySignals(BASE_CHAIN_ID, BRIDGED_USDT) })
    );
    expect(response.verdict).to.equal("UNKNOWN");
    expect(response.proceed).to.equal(false);
    expect(row(response, "asset-is-canonical").status).to.equal("UNVERIFIED");
  });

  it("keeps the pay Conditions that read a policy field out of the profile", () => {
    const ids = FLOOR_PROFILE.pay.map((condition) => condition.id);
    for (const id of [
      "recipient-matches-policy",
      "amount-within-cap",
      "chain-matches-intent",
      "role-requirement-met",
      "authorization-window-within-ceiling",
    ]) {
      expect(ids, id).to.not.include(id);
    }
  });
});

describe("floor profile: a swap with no policy", () => {
  it("a swap of canonical tokens inside the ceiling, tax read as 0, is ALLOW_UNDER_POLICY", () => {
    const response = consultFloor(swapAt(CAP - 1), swapFacts());
    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(response.proceed).to.equal(true);
    expect(response.floorIds).to.deep.equal([
      "target-is-canonical",
      "token-in-is-canonical",
      "token-out-is-canonical",
      "approval-scoped-to-this-swap",
      SLIPPAGE_ID,
      TAX_ID,
    ]);
    expect(row(response, TAX_ID).code).to.equal(
      "SWAP_TAX_WITHIN_BOUND_CANONICAL"
    );
    // The quote is the caller's own statement: the weakest PASS in the swap.
    expect(row(response, SLIPPAGE_ID).evidenceClass).to.equal("caller-stated");
    expect(response.support).to.equal(0.9);
    expect(response.band).to.equal("green");
  });

  it("a swap above the ceiling is DENY", () => {
    const response = consultFloor(swapAt(CAP + 10), swapFacts());
    expect(response.verdict).to.equal("DENY");
    expect(row(response, SLIPPAGE_ID).code).to.equal(
      "SWAP_FLOOR_SLIPPAGE_EXCEEDS_CEILING"
    );
  });

  it("at the ceiling is PASS and one unit of minOut below it is DENY", () => {
    const at = consultFloor(swapAt(CAP), swapFacts());
    expect(row(at, SLIPPAGE_ID).code).to.equal(
      "SWAP_FLOOR_SLIPPAGE_WITHIN_CEILING"
    );
    expect(at.verdict).to.equal("ALLOW_UNDER_POLICY");
    const above = consultFloor(swapAt(CAP, 1), swapFacts());
    expect(row(above, SLIPPAGE_ID).code).to.equal(
      "SWAP_FLOOR_SLIPPAGE_EXCEEDS_CEILING"
    );
    expect(above.verdict).to.equal("DENY");
  });

  it("with no params constant, a swap is UNKNOWN on the slippage Check", () => {
    for (const params of [
      NONE,
      withoutConstant(SLIPPAGE_FILE, "tolerance_cap_deny_above_bps"),
      { not: "a bundle" },
    ]) {
      const response = consultFloor(
        swapAt(CAP - 1),
        swapFacts(undefined, params)
      );
      const slippage = row(response, SLIPPAGE_ID);
      expect(slippage.status).to.equal("UNVERIFIED");
      expect(slippage.code).to.equal("SWAP_FLOOR_CEILING_MISSING");
      expect(response.verdict).to.equal("UNKNOWN");
    }
  });

  it("a constant that is not a whole number of basis points in range is not a ceiling", () => {
    for (const value of [-1, 77.5, 10_001, "77", Number.NaN]) {
      const params = floorBundle((bundle) => {
        bundle[SLIPPAGE_FILE].tolerance_cap_deny_above_bps.value = value;
      });
      const response = consultFloor(
        swapAt(CAP - 1),
        swapFacts(undefined, params)
      );
      expect(row(response, SLIPPAGE_ID).code, String(value)).to.equal(
        "SWAP_FLOOR_CEILING_MISSING"
      );
    }
  });

  it("a swap with minOut 0 is DENY, with or without a ceiling", () => {
    const request = makeSwapRequest({
      action: {
        ...makeSwapRequest().action,
        minOut: "0",
        slippageBps: 10000,
      },
    });
    for (const params of [floorBundle(), NONE]) {
      const response = consultFloor(request, swapFacts(undefined, params));
      expect(response.verdict).to.equal("DENY");
      expect(row(response, SLIPPAGE_ID).code).to.equal(
        "SWAP_FLOOR_MIN_OUT_ZERO"
      );
    }
  });

  it("every request-shape FAIL of the owner's check is a FAIL here, under its own code", () => {
    const base = makeSwapRequest().action;
    const cases: [string, Record<string, unknown>, string][] = [
      ["malformed amounts", { minOut: "9.5" }, "SWAP_FLOOR_AMOUNTS_MALFORMED"],
      ["quotedOut 0", { quotedOut: "0" }, "SWAP_FLOOR_QUOTED_OUT_ZERO"],
      [
        "minOut over quote",
        { minOut: "1000001", slippageBps: 0 },
        "SWAP_FLOOR_MIN_OUT_EXCEEDS_QUOTE",
      ],
      ["bps malformed", { slippageBps: 1.5 }, "SWAP_FLOOR_BPS_MALFORMED"],
      ["bps mismatch", { slippageBps: 49 }, "SWAP_FLOOR_DECLARED_MISMATCH"],
    ];
    for (const [label, change, code] of cases) {
      const response = consultFloor(
        makeSwapRequest({ action: { ...base, ...change } }),
        swapFacts()
      );
      expect(row(response, SLIPPAGE_ID).code, label).to.equal(code);
      expect(row(response, SLIPPAGE_ID).status, label).to.equal("FAIL");
      expect(response.verdict, label).to.equal("DENY");
    }
  });

  it("the floor's slippage codes never reuse the owner's SLIPPAGE_ names", () => {
    const profile = FLOOR_PROFILE.swap.find((c) => c.id === SLIPPAGE_ID)!;
    const owner = CATALOG.swap.find((c) => c.id === "slippage-within-ceiling")!;
    const own = [
      ...owner.codes.fail,
      ...owner.codes.unverified,
      owner.codes.pass as string,
    ];
    const mine = [
      ...profile.codes.fail,
      ...profile.codes.unverified,
      ...(profile.codes.pass as readonly string[]),
    ];
    expect(mine.filter((code) => own.includes(code))).to.deep.equal([]);
    expect(mine.filter((code) => code.startsWith("SLIPPAGE_"))).to.deep.equal(
      []
    );
  });

  it("keeps the swap Conditions that read a policy field out of the profile", () => {
    const ids = FLOOR_PROFILE.swap.map((condition) => condition.id);
    for (const id of [
      "slippage-within-ceiling",
      "deadline-set-and-fresh",
      "output-recipient-is-owner",
      "amount-within-cap",
      "chain-matches-intent",
      "role-requirement-met",
    ]) {
      expect(ids, id).to.not.include(id);
    }
  });

  it("an unlisted token on either side holds the swap at UNKNOWN, never ALLOW", () => {
    const response = consultFloor(
      swapOf(UNLISTED_TOKEN),
      swapFacts([
        USDC_TAX,
        {
          chainId: CHAIN_ID,
          address: UNLISTED_TOKEN.contractAddress,
          taxBps: 0,
          sellBlocked: false,
          asOf: NOW,
          source: "simulation",
        },
      ])
    );
    expect(response.verdict).to.equal("UNKNOWN");
    expect(response.proceed).to.equal(false);
  });

  it("a request key naming a tax, on the request or its action, moves nothing", () => {
    const request = {
      ...swapAt(CAP - 1),
      tokenTax: [{ taxBps: 0 }],
      action: { ...swapAt(CAP - 1).action, taxBps: 0, sellBlocked: false },
    };
    const response = consultFloor(request as never, swapFacts([]));
    expect(row(response, TAX_ID).code).to.equal("SWAP_TAX_FACT_MISSING");
    expect(response.verdict).to.equal("UNKNOWN");
  });
});

describe("floor profile: the owner layer on top", () => {
  it("a cap the request exceeds is DENY though the floor passed", () => {
    const request = payOf("USDT", ETHEREUM_USDT);
    const facts = payFacts({ registryAsset: usdtRegistryFact() });
    const policy = makePolicy({
      perActionCaps: { pay: "10" },
      perActionCapAssets: { pay: ETHEREUM_USDT },
      approvedRecipients: [request.action.recipient!],
    });
    expect(consultFloor(request, facts).verdict).to.equal("ALLOW_UNDER_POLICY");
    const response = consultWithFloor(request, policy, facts);
    expect(response.verdict).to.equal("DENY");
    expect(response.proceed).to.equal(false);
    expect(row(response, "amount-within-cap").code).to.equal(
      "AMOUNT_EXCEEDS_CAP"
    );
    expect(response.support).to.equal(0);
  });

  it("an owner whose ceiling is tighter than the floor's denies a swap the floor passed", () => {
    const request = swapAt(CAP - 1);
    const response = consultWithFloor(
      request,
      makeSwapPolicy({ maxSlippageBps: 1 }),
      swapFacts()
    );
    expect(consultFloor(request, swapFacts()).verdict).to.equal(
      "ALLOW_UNDER_POLICY"
    );
    expect(response.verdict).to.equal("DENY");
    expect(row(response, "slippage-within-ceiling").status).to.equal("FAIL");
  });

  it("no policy turns a floor DENY into a pass", () => {
    const permissive = makeSwapPolicy({
      maxSlippageBps: 10000,
      perActionCaps: { pay: "1000000000", swap: "1000000000" },
    });
    const request = swapAt(CAP + 10);
    expect(consult(request, permissive, swapFacts()).verdict).to.equal(
      "ALLOW_UNDER_POLICY"
    );
    const response = consultWithFloor(request, permissive, swapFacts());
    expect(response.verdict).to.equal("DENY");
    expect(response.proceed).to.equal(false);
    expect(row(response, SLIPPAGE_ID).status).to.equal("FAIL");
  });

  it("no policy field removes the tax rule", () => {
    const blocked = swapFacts([USDC_TAX, { ...WETH_TAX, sellBlocked: true }]);
    for (const policy of [
      makeSwapPolicy(),
      makeSwapPolicy({ maxSlippageBps: 10000, permits: true }),
    ]) {
      const response = consultWithFloor(swapAt(CAP - 1), policy, blocked);
      expect(response.verdict).to.equal("DENY");
      expect(row(response, TAX_ID).code).to.equal("SWAP_TOKEN_SELL_BLOCKED");
    }
  });

  it("a policy that does not permit holds an all-PASS floor at UNKNOWN", () => {
    const request = swapAt(CAP - 1);
    const response = consultWithFloor(
      request,
      makeSwapPolicy({ permits: false }),
      swapFacts()
    );
    expect(response.verdict).to.equal("UNKNOWN");
    expect(response.proceed).to.equal(false);
  });

  it("a floor UNKNOWN holds a policy that permits at UNKNOWN", () => {
    const response = consultWithFloor(
      swapAt(CAP - 1),
      makeSwapPolicy(),
      swapFacts(undefined, NONE)
    );
    expect(row(response, SLIPPAGE_ID).status).to.equal("UNVERIFIED");
    expect(response.verdict).to.equal("UNKNOWN");
  });

  it("all-PASS floor and owner is ALLOW, one row per id, worst rows first", () => {
    const request = swapAt(CAP - 1);
    const response = consultWithFloor(request, makeSwapPolicy(), swapFacts());
    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    const ids = response.results.map((result) => result.id);
    expect(new Set(ids).size).to.equal(ids.length);
    expect(ids).to.include.members([
      TAX_ID,
      SLIPPAGE_ID,
      "slippage-within-ceiling",
      "output-recipient-is-owner",
    ]);
    expect(response.advisory).to.equal(true);
  });

  it("the owner path never carries a floor-only row, and its answers are the catalog's own", () => {
    const request = swapAt(CAP - 1);
    const response = consult(request, makeSwapPolicy(), swapFacts());
    const ids = response.results.map((result) => result.id);
    expect(ids).to.not.include(TAX_ID);
    expect(ids).to.not.include(SLIPPAGE_ID);
    expect(CATALOG.swap.map((c) => c.id)).to.not.include(TAX_ID);
    expect(CATALOG.swap.map((c) => c.id)).to.not.include(SLIPPAGE_ID);
    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
  });

  it("the owner path answers the same with and without the four new constants in the bundle", () => {
    const cases: [ConsultRequest, Policy][] = [
      [swapAt(CAP - 1), makeSwapPolicy()],
      [swapAt(CAP + 10), makeSwapPolicy()],
      [swapAt(CAP, 1), makeSwapPolicy({ maxSlippageBps: CAP })],
      [makeSwapRequest(), makeSwapPolicy({ maxSlippageBps: undefined })],
      [payOf("USDT", ETHEREUM_USDT), makePolicy()],
      [makeRequest(), makePolicy()],
    ];
    for (const [request, policy] of cases) {
      for (const tokenTax of [undefined, [USDC_TAX, WETH_TAX]]) {
        const plain = { now: NOW, registryAsset: usdtRegistryFact() };
        const withBundle = {
          ...plain,
          params: floorBundle(),
          ...(tokenTax === undefined ? {} : { tokenTax }),
        };
        expect(JSON.stringify(consult(request, policy, withBundle))).to.equal(
          JSON.stringify(consult(request, policy, plain))
        );
      }
    }
  });

  it("an unknown action type is UNKNOWN on the floor path too", () => {
    const request = makeRequest({
      action: { ...makeRequest().action, type: "bridge" },
    });
    expect(consultFloor(request).verdict).to.equal("UNKNOWN");
    expect(consultWithFloor(request, makePolicy(), undefined).verdict).to.equal(
      "UNKNOWN"
    );
  });

  it("a request that fails to parse is UNKNOWN, not a throw", () => {
    expect(consultFloor(null as never).verdict).to.equal("UNKNOWN");
    expect(
      consultWithFloor(null as never, makePolicy(), undefined).verdict
    ).to.equal("UNKNOWN");
  });
});

describe("floor profile: the profile is code-owned", () => {
  it("the profile is frozen end to end", () => {
    expect(Object.isFrozen(FLOOR_PROFILE)).to.equal(true);
    expect(Object.isFrozen(FLOOR_PROFILE.pay)).to.equal(true);
    expect(Object.isFrozen(FLOOR_PROFILE.swap)).to.equal(true);
    expect(() => (FLOOR_PROFILE.swap as unknown[]).pop()).to.throw();
    expect(() => ((FLOOR_PROFILE.pay as unknown[]).length = 0)).to.throw();
  });

  it("no member is a policy reader, and every member is a Floor member", () => {
    for (const condition of [...FLOOR_PROFILE.pay, ...FLOOR_PROFILE.swap]) {
      expect(
        POLICY_READING_CONDITION_IDS.has(condition.id),
        condition.id
      ).to.equal(false);
      expect(condition.isFloor, condition.id).to.equal(true);
      expect(condition.policyFields ?? [], condition.id).to.deep.equal([]);
    }
  });

  it("an ALLOW needs no catalog row, so the floor ids on the response are exactly the profile's", () => {
    const response = consultFloor(swapAt(CAP - 1), swapFacts());
    expect(response.floorIds).to.deep.equal(
      FLOOR_PROFILE.swap.map((condition) => condition.id)
    );
  });

  it("reads the slippage ceiling only through the listed params pair", () => {
    expect(SLIPPAGE_MEV_PARAMS_ID).to.equal(SLIPPAGE_FILE);
    const moved = consultFloor(
      swapAt(CAP - 1),
      swapFacts(
        undefined,
        floorBundle((bundle) => {
          bundle[SLIPPAGE_FILE].tolerance_cap_deny_above_bps.value = CAP - 2;
        })
      )
    );
    expect(row(moved, SLIPPAGE_ID).status).to.equal("FAIL");
    const widened = consultFloor(
      swapAt(CAP + 10),
      swapFacts(
        undefined,
        floorBundle((bundle) => {
          bundle[SLIPPAGE_FILE].tolerance_cap_deny_above_bps.value = CAP + 10;
        })
      )
    );
    expect(row(widened, SLIPPAGE_ID).status).to.equal("PASS");
  });
});
