import { expect } from "chai";

import { consultFloor } from "../src";
import {
  ASSET_ADDRESS,
  CHAIN_ID,
  WETH_ADDRESS,
  makeSwapRequest,
} from "./fixtures";
import {
  EVIDENCE_CLASS_WEIGHTS,
  MAX_TAX_READING_AGE_SECONDS,
} from "../src/constants";
import {
  CAP,
  NONE,
  NOW,
  SLIPPAGE_FILE,
  TAX_ID,
  TAX_MAX,
  TAX_UNKNOWN,
  TOL_FLOOR,
  UNKNOWN_FILE,
  UNLISTED_TOKEN,
  USDC_TAX,
  WETH,
  WETH_TAX,
  floorBundle,
  row,
  swapAt,
  swapFacts,
  swapOf,
  taxEntry,
  withConstant,
  withoutConstant,
} from "./floor-fixtures";

const USDC = USDC_TAX as { address: string };
const SIM = { source: "simulation" } as const;

// A swap of two canonical tokens whose tax Facts are simulation readings.
function taxed(inTax: number, outTax: number, params?: unknown) {
  return consultFloor(
    swapAt(CAP - 1),
    swapFacts(
      [
        taxEntry(ASSET_ADDRESS, { ...SIM, taxBps: inTax }),
        taxEntry(WETH_ADDRESS, { ...SIM, taxBps: outTax }),
      ],
      params
    )
  );
}

function taxRow(response: ReturnType<typeof consultFloor>) {
  return row(response, TAX_ID);
}

// A swap from USDC to a token neither table lists, with a tax reading for it.
function unknownOut(tax: number, params?: unknown) {
  return consultFloor(
    swapOf(UNLISTED_TOKEN),
    swapFacts(
      [
        USDC_TAX,
        taxEntry(UNLISTED_TOKEN.contractAddress, { ...SIM, taxBps: tax }),
      ],
      params
    )
  );
}

describe("token tax rule: what a PASS and a DENY need", () => {
  it("canonical entries on both legs read 0, PASS under static-registry", () => {
    const response = consultFloor(swapAt(CAP - 1), swapFacts());
    const tax = taxRow(response);
    expect(tax.status).to.equal("PASS");
    expect(tax.code).to.equal("SWAP_TAX_WITHIN_BOUND_CANONICAL");
    expect(tax.evidenceClass).to.equal("static-registry");
  });

  it("a simulation reading on either leg makes the PASS simulated, the weaker class", () => {
    for (const [inTax, outTax] of [
      [0, 40],
      [40, 0],
      [40, 40],
    ]) {
      const tax = taxRow(taxed(inTax, outTax));
      expect(tax.code, `${inTax}/${outTax}`).to.equal(
        "SWAP_TAX_WITHIN_BOUND_SIMULATED"
      );
      expect(tax.evidenceClass).to.equal("simulated");
    }
  });

  it("a simulated PASS lowers support below a static-registry one", () => {
    const registry = consultFloor(swapAt(CAP - 1), swapFacts());
    const simulated = taxed(0, 40);
    expect(registry.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(simulated.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(simulated.support).to.be.at.most(registry.support);
  });

  it("at the bound is PASS and one bps above is DENY (both legs known)", () => {
    const room = TAX_MAX - TOL_FLOOR;
    const at = taxed(room - 100, 100);
    expect(taxRow(at).status).to.equal("PASS");
    const above = taxed(room - 100, 101);
    expect(taxRow(above).status).to.equal("FAIL");
    expect(taxRow(above).code).to.equal("SWAP_TAX_EXCEEDS_BOUND");
    expect(taxRow(above).evidenceClass).to.equal("simulated");
    expect(above.verdict).to.equal("DENY");
  });

  it("adds the two legs' taxes: two taxes the larger alone would pass are DENY", () => {
    const each = Math.floor((TAX_MAX - TOL_FLOOR) / 2) + 1;
    expect(each + TOL_FLOOR).to.be.at.most(TAX_MAX);
    const response = taxed(each, each);
    expect(taxRow(response).code).to.equal("SWAP_TAX_EXCEEDS_BOUND");
    expect(response.verdict).to.equal("DENY");
  });

  it("one taxed leg: the sum is that tax, so the single-leg boundary is unchanged", () => {
    const room = TAX_MAX - TOL_FLOOR;
    expect(taxRow(taxed(room, 0)).status).to.equal("PASS");
    expect(taxRow(taxed(0, room)).status).to.equal("PASS");
    expect(taxRow(taxed(room + 1, 0)).status).to.equal("FAIL");
    expect(taxRow(taxed(0, room + 1)).status).to.equal("FAIL");
  });

  it("computes on tolerance_floor_bps: moving it moves the boundary by exactly its change", () => {
    const room = TAX_MAX - TOL_FLOOR;
    const params = withConstant(
      SLIPPAGE_FILE,
      "tolerance_floor_bps",
      TOL_FLOOR + 1
    );
    expect(taxRow(taxed(room, 0, params)).status).to.equal("FAIL");
    expect(taxRow(taxed(room - 1, 0, params)).status).to.equal("PASS");
  });

  it("a zero tax with zero floor passes whatever the bound, and a tax alone can fail", () => {
    const params = floorBundle((bundle) => {
      bundle[SLIPPAGE_FILE].tolerance_floor_bps.value = 0;
      bundle[SLIPPAGE_FILE].tax_plus_honest_tolerance_max_bps.value = 0;
    });
    expect(taxRow(taxed(0, 0, params)).status).to.equal("PASS");
    expect(taxRow(taxed(1, 0, params)).status).to.equal("FAIL");
  });
});

describe("token tax rule: an unknown token reads its own file's constant", () => {
  it("a leg the tables do not know reads tax_plus_honest_tolerance_deny_above_bps", () => {
    const room = TAX_UNKNOWN - TOL_FLOOR;
    expect(taxRow(unknownOut(room)).status).to.equal("PASS");
    expect(taxRow(unknownOut(room)).code).to.equal(
      "SWAP_TAX_WITHIN_BOUND_SIMULATED"
    );
    const above = unknownOut(room + 1);
    expect(taxRow(above).code).to.equal("SWAP_TAX_EXCEEDS_BOUND");
    expect(above.verdict).to.equal("DENY");
  });

  it("an unknown token's swap is never ALLOW: the canonical Conditions hold it", () => {
    const response = unknownOut(0);
    expect(response.verdict).to.equal("UNKNOWN");
    expect(response.proceed).to.equal(false);
  });

  it("changing one constant changes only its class", () => {
    const knownRoom = TAX_MAX - TOL_FLOOR;
    const unknownRoom = TAX_UNKNOWN - TOL_FLOOR;
    expect(knownRoom).to.not.equal(unknownRoom);

    // Moving the known-token bound leaves the unknown-token row alone.
    const lowerMax = withConstant(
      SLIPPAGE_FILE,
      "tax_plus_honest_tolerance_max_bps",
      0
    );
    expect(taxRow(unknownOut(unknownRoom, lowerMax)).status).to.equal("PASS");
    expect(taxRow(taxed(1, 0, lowerMax)).status).to.equal("FAIL");

    // Moving the unknown-token bound leaves the known-token row alone.
    const lowerUnknown = withConstant(
      UNKNOWN_FILE,
      "tax_plus_honest_tolerance_deny_above_bps",
      0
    );
    expect(taxRow(taxed(knownRoom, 0, lowerUnknown)).status).to.equal("PASS");
    expect(taxRow(unknownOut(1, lowerUnknown)).status).to.equal("FAIL");
  });

  it("the bound it needs missing is UNVERIFIED, so UNKNOWN; the other file's constant cannot stand in", () => {
    const noMax = withoutConstant(
      SLIPPAGE_FILE,
      "tax_plus_honest_tolerance_max_bps"
    );
    const known = taxed(0, 0, noMax);
    expect(taxRow(known).status).to.equal("UNVERIFIED");
    expect(taxRow(known).code).to.equal("SWAP_TAX_BOUND_MISSING");
    expect(known.verdict).to.equal("UNKNOWN");
    const noUnknown = withoutConstant(
      UNKNOWN_FILE,
      "tax_plus_honest_tolerance_deny_above_bps"
    );
    expect(taxRow(unknownOut(0, noUnknown)).code).to.equal(
      "SWAP_TAX_BOUND_MISSING"
    );
    // The known-token bound does not need the unknown-token constant.
    expect(taxRow(taxed(0, 0, noUnknown)).status).to.equal("PASS");
  });

  it("a missing tolerance_floor_bps, and no bundle at all, are UNVERIFIED", () => {
    for (const params of [
      withoutConstant(SLIPPAGE_FILE, "tolerance_floor_bps"),
      NONE,
      "not a bundle",
    ]) {
      const response = taxed(0, 0, params);
      expect(taxRow(response).code).to.equal("SWAP_TAX_BOUND_MISSING");
      expect(response.verdict).to.equal("UNKNOWN");
    }
  });

  it("a constant that is not a whole number of basis points is no bound", () => {
    for (const value of [
      -1,
      "230",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      77.5,
      10001,
    ]) {
      for (const [file, key] of [
        [SLIPPAGE_FILE, "tax_plus_honest_tolerance_max_bps"],
        [SLIPPAGE_FILE, "tolerance_floor_bps"],
        [UNKNOWN_FILE, "tax_plus_honest_tolerance_deny_above_bps"],
      ]) {
        const params = withConstant(file, key, value);
        const response =
          key === "tax_plus_honest_tolerance_deny_above_bps"
            ? unknownOut(0, params)
            : taxed(0, 0, params);
        expect(taxRow(response).code, `${key} ${String(value)}`).to.equal(
          "SWAP_TAX_BOUND_MISSING"
        );
      }
    }
  });

  it("a constant labelled for anything but check or both is never read: the rule answers UNVERIFIED", () => {
    for (const label of [
      "fixture-label-not-check",
      "fixture-label-unassigned",
      "next",
    ]) {
      const params = floorBundle((bundle) => {
        bundle[SLIPPAGE_FILE].tax_plus_honest_tolerance_max_bps.used_by = label;
      });
      expect(taxRow(taxed(0, 0, params)).code, label).to.equal(
        "SWAP_TAX_BOUND_MISSING"
      );
    }
  });
});

describe("token tax rule: the legs together pick the bound and the class", () => {
  const unlistedIn = (tax: number) =>
    consultFloor(
      swapOf(WETH, UNLISTED_TOKEN),
      swapFacts([
        taxEntry(UNLISTED_TOKEN.contractAddress, { ...SIM, taxBps: tax }),
        WETH_TAX,
      ])
    );

  it("an unlisted tokenIn with a known tokenOut reads the unknown-token bound", () => {
    const room = TAX_UNKNOWN - TOL_FLOOR;
    expect(room).to.be.below(TAX_MAX - TOL_FLOOR);
    const above = unlistedIn(room + 1);
    expect(taxRow(above).status).to.equal("FAIL");
    expect(taxRow(above).code).to.equal("SWAP_TAX_EXCEEDS_BOUND");
    expect(above.verdict).to.equal("DENY");
    expect(taxRow(unlistedIn(room)).status).to.equal("PASS");
  });

  it("one simulation leg makes the PASS simulated, whichever leg it is", () => {
    for (const entries of [
      [taxEntry(ASSET_ADDRESS, { ...SIM, taxBps: 0 }), WETH_TAX],
      [USDC_TAX, taxEntry(WETH_ADDRESS, { ...SIM, taxBps: 0 })],
    ]) {
      const tax = taxRow(consultFloor(swapAt(CAP - 1), swapFacts(entries)));
      expect(tax.status).to.equal("PASS");
      expect(tax.code).to.equal("SWAP_TAX_WITHIN_BOUND_SIMULATED");
    }
  });

  it("a sellBlocked entry denies even when its leg has a second entry", () => {
    const response = consultFloor(
      swapAt(CAP - 1),
      swapFacts([
        USDC_TAX,
        taxEntry(ASSET_ADDRESS, { ...SIM, sellBlocked: true }),
        WETH_TAX,
      ])
    );
    expect(taxRow(response).code).to.equal("SWAP_TOKEN_SELL_BLOCKED");
    expect(response.verdict).to.equal("DENY");
  });
});

describe("token tax rule: sellBlocked", () => {
  const blockedWeth = taxEntry(WETH_ADDRESS, {
    ...SIM,
    taxBps: 0,
    sellBlocked: true,
  });

  it("is DENY whatever the bound and with no params present", () => {
    for (const params of [
      NONE,
      "not a bundle",
      withoutConstant(SLIPPAGE_FILE, "tax_plus_honest_tolerance_max_bps"),
      floorBundle(),
    ]) {
      const response = consultFloor(
        swapAt(CAP - 1),
        swapFacts([USDC_TAX, blockedWeth], params)
      );
      expect(taxRow(response).status).to.equal("FAIL");
      expect(taxRow(response).code).to.equal("SWAP_TOKEN_SELL_BLOCKED");
      expect(taxRow(response).evidenceClass).to.equal("simulated");
      expect(response.verdict).to.equal("DENY");
    }
  });

  it("is DENY on token in as well as token out", () => {
    const response = consultFloor(
      swapAt(CAP - 1),
      swapFacts([{ ...USDC_TAX, ...SIM, sellBlocked: true }, WETH_TAX])
    );
    expect(taxRow(response).code).to.equal("SWAP_TOKEN_SELL_BLOCKED");
  });

  it("needs only a subject match and sellBlocked true: taxBps, asOf and source may be absent", () => {
    for (const entry of [
      { chainId: CHAIN_ID, address: WETH_ADDRESS, sellBlocked: true },
      {
        chainId: CHAIN_ID,
        address: WETH_ADDRESS.toLowerCase(),
        sellBlocked: true,
        taxBps: "junk",
        asOf: "junk",
        source: 7,
      },
    ]) {
      const response = consultFloor(
        swapAt(CAP - 1),
        swapFacts([USDC_TAX, entry])
      );
      expect(taxRow(response).code).to.equal("SWAP_TOKEN_SELL_BLOCKED");
    }
  });

  it("denies whatever the reading's age", () => {
    const old = taxEntry(WETH_ADDRESS, {
      ...SIM,
      sellBlocked: true,
      asOf: NOW - 10 * MAX_TAX_READING_AGE_SECONDS,
    });
    const response = consultFloor(swapAt(CAP - 1), swapFacts([USDC_TAX, old]));
    expect(taxRow(response).code).to.equal("SWAP_TOKEN_SELL_BLOCKED");
    const noNow = consultFloor(swapAt(CAP - 1), {
      params: floorBundle(),
      tokenTax: [USDC_TAX, old],
    });
    expect(taxRow(noNow).code).to.equal("SWAP_TOKEN_SELL_BLOCKED");
  });

  it("applies only to an entry about this leg: another token, or another chain, is ignored", () => {
    const other = [
      taxEntry(UNLISTED_TOKEN.contractAddress, { ...SIM, sellBlocked: true }),
      taxEntry(WETH_ADDRESS, {
        ...SIM,
        sellBlocked: true,
        chainId: "eip155:8453",
      }),
    ];
    const response = consultFloor(
      swapAt(CAP - 1),
      swapFacts([USDC_TAX, WETH_TAX, ...other])
    );
    expect(taxRow(response).status).to.equal("PASS");
  });

  it('only a literal true blocks: false, 1, "true" and null do not', () => {
    for (const value of [false, 1, "true", null]) {
      const response = consultFloor(
        swapAt(CAP - 1),
        swapFacts([
          USDC_TAX,
          taxEntry(WETH_ADDRESS, { ...SIM, sellBlocked: value }),
        ])
      );
      expect(taxRow(response).code, String(value)).to.not.equal(
        "SWAP_TOKEN_SELL_BLOCKED"
      );
    }
  });
});

describe("token tax rule: a tax that cannot be read is UNKNOWN", () => {
  const unverified = (facts: unknown, code: string, label = code) => {
    const response = consultFloor(swapAt(CAP - 1), facts);
    expect(taxRow(response).status, label).to.equal("UNVERIFIED");
    expect(taxRow(response).code, label).to.equal(code);
    expect(taxRow(response).evidenceClass, label).to.equal("not-verifiable");
    expect(response.verdict, label).to.equal("UNKNOWN");
    expect(response.proceed, label).to.equal(false);
  };

  it("no Fact at all, an empty list, or a Fact that is not a list", () => {
    unverified(swapFacts(NONE), "SWAP_TAX_FACT_MISSING", "absent");
    unverified(swapFacts([]), "SWAP_TAX_FACT_MISSING", "empty");
    unverified(
      { now: NOW, params: floorBundle(), tokenTax: { ...USDC_TAX } },
      "SWAP_TAX_FACT_MISSING",
      "object"
    );
    unverified(
      { now: NOW, params: floorBundle(), tokenTax: "0" },
      "SWAP_TAX_FACT_MISSING",
      "string"
    );
  });

  it("one leg with no Fact makes the rule UNVERIFIED, even when the other reads 0", () => {
    unverified(swapFacts([USDC_TAX]), "SWAP_TAX_FACT_MISSING", "token out");
    unverified(swapFacts([WETH_TAX]), "SWAP_TAX_FACT_MISSING", "token in");
  });

  it("a native-asset leg has no Fact, so the swap is UNKNOWN; WETH reads canonical 0 like any other", () => {
    const native = swapOf({
      symbol: "ETH",
      contractAddress: "0x" + "0".repeat(40),
    });
    const response = consultFloor(native, swapFacts([USDC_TAX]));
    expect(taxRow(response).code).to.equal("SWAP_TAX_FACT_MISSING");
    expect(response.verdict).to.equal("UNKNOWN");
    const weth = consultFloor(swapAt(CAP - 1), swapFacts());
    expect(taxRow(weth).code).to.equal("SWAP_TAX_WITHIN_BOUND_CANONICAL");
  });

  it("a Fact for another token, or another chain, is no Fact for the leg", () => {
    unverified(
      swapFacts([
        USDC_TAX,
        taxEntry(UNLISTED_TOKEN.contractAddress),
        taxEntry(WETH_ADDRESS, { chainId: "eip155:8453" }),
      ]),
      "SWAP_TAX_FACT_MISSING"
    );
  });

  it("a leg with a malformed address matches nothing", () => {
    const bad = makeSwapRequest({
      action: {
        ...makeSwapRequest().action,
        tokenOut: { symbol: "WETH", contractAddress: "0xnot-an-address" },
      },
    });
    const response = consultFloor(bad, swapFacts());
    expect(taxRow(response).code).to.equal("SWAP_TAX_FACT_MISSING");
  });

  it("two entries for one token are ambiguous, never first-wins", () => {
    unverified(
      swapFacts([
        USDC_TAX,
        WETH_TAX,
        taxEntry(WETH_ADDRESS, { ...SIM, taxBps: 900 }),
      ]),
      "SWAP_TAX_FACT_AMBIGUOUS"
    );
  });

  const malformed: [string, Record<string, unknown>][] = [
    ["taxBps negative", { taxBps: -1, ...SIM }],
    ["taxBps fractional", { taxBps: 1.5, ...SIM }],
    ["taxBps over 10000", { taxBps: 10_001, ...SIM }],
    ["taxBps a string", { taxBps: "0", ...SIM }],
    ["taxBps NaN", { taxBps: Number.NaN, ...SIM }],
    ["taxBps missing", { taxBps: undefined, ...SIM }],
    ["sellBlocked missing", { sellBlocked: undefined }],
    ["sellBlocked a string", { sellBlocked: "false" }],
    ["source unknown", { source: "oracle" }],
    ["source missing", { source: undefined }],
    ["asOf not an integer", { asOf: 1.5 }],
    ["asOf a string", { asOf: String(NOW) }],
  ];
  for (const [label, change] of malformed) {
    it(`${label} is a malformed Fact`, () => {
      unverified(
        swapFacts([USDC_TAX, taxEntry(WETH_ADDRESS, change)]),
        "SWAP_TAX_FACT_MALFORMED",
        label
      );
    });
  }

  it("a reading older than the limit is stale; one at the limit is fresh", () => {
    const at = taxEntry(WETH_ADDRESS, {
      ...SIM,
      asOf: NOW - MAX_TAX_READING_AGE_SECONDS,
    });
    expect(
      taxRow(consultFloor(swapAt(CAP - 1), swapFacts([USDC_TAX, at]))).status
    ).to.equal("PASS");
    const stale = taxEntry(WETH_ADDRESS, {
      ...SIM,
      asOf: NOW - MAX_TAX_READING_AGE_SECONDS - 1,
    });
    unverified(swapFacts([USDC_TAX, stale]), "SWAP_TAX_FACT_STALE");
  });

  it("a stale reading over the bound is UNVERIFIED, not DENY: age is checked before the sum", () => {
    const stale = taxEntry(WETH_ADDRESS, {
      ...SIM,
      taxBps: 9000,
      asOf: NOW - MAX_TAX_READING_AGE_SECONDS - 1,
    });
    unverified(swapFacts([USDC_TAX, stale]), "SWAP_TAX_FACT_STALE");
  });

  it("a canonical entry is dated like any other", () => {
    const stale = taxEntry(WETH_ADDRESS, {
      asOf: NOW - MAX_TAX_READING_AGE_SECONDS - 1,
    });
    unverified(swapFacts([USDC_TAX, stale]), "SWAP_TAX_FACT_STALE");
  });

  it("a reading dated after now, or with no valid now, has an unknown age", () => {
    unverified(
      swapFacts([USDC_TAX, taxEntry(WETH_ADDRESS, { ...SIM, asOf: NOW + 1 })]),
      "SWAP_TAX_AGE_UNKNOWN",
      "future"
    );
    for (const now of [undefined, 0, -5, 1.5, "now"]) {
      unverified(
        { ...swapFacts(), now },
        "SWAP_TAX_AGE_UNKNOWN",
        `now ${String(now)}`
      );
    }
  });

  it("facts that are not an object give no Fact", () => {
    for (const facts of [undefined, null, "facts", 7, []]) {
      unverified(facts, "SWAP_TAX_FACT_MISSING", JSON.stringify(facts));
    }
  });
});

describe("token tax rule: a canonical entry counts only where the tables confirm the token", () => {
  it("a canonical entry for a token the tables do not know is UNVERIFIED, never a free 0", () => {
    const response = consultFloor(
      swapOf(UNLISTED_TOKEN),
      swapFacts([
        USDC_TAX,
        taxEntry(UNLISTED_TOKEN.contractAddress, { source: "canonical" }),
      ])
    );
    expect(taxRow(response).code).to.equal("SWAP_TAX_CANONICAL_UNCONFIRMED");
    expect(taxRow(response).status).to.equal("UNVERIFIED");
  });

  it("a canonical entry at a lookalike address of a listed symbol is UNVERIFIED", () => {
    const lookalike = {
      symbol: "WETH",
      contractAddress: "0x" + "6".repeat(40),
    };
    const response = consultFloor(
      swapOf(lookalike),
      swapFacts([USDC_TAX, taxEntry(lookalike.contractAddress)])
    );
    expect(taxRow(response).code).to.equal("SWAP_TAX_CANONICAL_UNCONFIRMED");
    expect(response.verdict).to.equal("DENY");
  });

  it("a canonical entry above 0 is UNVERIFIED, even for a listed token", () => {
    const response = consultFloor(
      swapAt(CAP - 1),
      swapFacts([USDC_TAX, taxEntry(WETH_ADDRESS, { taxBps: 1 })])
    );
    expect(taxRow(response).code).to.equal("SWAP_TAX_CANONICAL_UNCONFIRMED");
  });

  it("a registry token with a confirmed live read at the exact address is known", () => {
    const usdt = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    const registry = {
      chainId: CHAIN_ID,
      symbol: "USDT",
      contractAddress: usdt,
      expiresAt: NOW + 86_400,
      liveRead: "confirmed",
      liveReadAt: NOW,
    };
    const request = swapOf({ symbol: "USDT", contractAddress: usdt });
    const response = consultFloor(
      request,
      swapFacts([USDC_TAX, taxEntry(usdt)], undefined, {
        registryAsset: registry,
      })
    );
    expect(taxRow(response).code).to.equal("SWAP_TAX_WITHIN_BOUND_CANONICAL");
    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");

    const unconfirmed = consultFloor(
      request,
      swapFacts([USDC_TAX, taxEntry(usdt)], undefined, {
        registryAsset: { ...registry, liveRead: "unconfirmed" },
      })
    );
    expect(taxRow(unconfirmed).code).to.equal("SWAP_TAX_CANONICAL_UNCONFIRMED");
  });

  it("a known leg with a simulation reading is a simulation: it may carry a tax", () => {
    const response = taxed(30, 0);
    expect(taxRow(response).code).to.equal("SWAP_TAX_WITHIN_BOUND_SIMULATED");
  });

  it("the USDC address in the entry matches case-insensitively, like every address compare", () => {
    const response = consultFloor(
      swapAt(CAP - 1),
      swapFacts([
        { ...USDC_TAX, address: USDC.address.toLowerCase() },
        {
          ...WETH_TAX,
          address: WETH.contractAddress.toUpperCase().replace("0X", "0x"),
        },
      ])
    );
    expect(taxRow(response).status).to.equal("PASS");
  });
});

describe("token tax rule: its reading age and its FAIL class", () => {
  it("the max reading age is 60 seconds, like the market and registry readings", () => {
    expect(MAX_TAX_READING_AGE_SECONDS).to.equal(60);
  });

  it("a DENY on canonical readings, where only the tolerance floor is over the bound, still reports simulated", () => {
    const params = floorBundle((bundle) => {
      bundle[SLIPPAGE_FILE].tolerance_floor_bps.value = TAX_MAX + 1;
    });
    const response = consultFloor(
      swapAt(CAP - 1),
      swapFacts(undefined, params)
    );
    expect(taxRow(response).code).to.equal("SWAP_TAX_EXCEEDS_BOUND");
    expect(taxRow(response).evidenceClass).to.equal("simulated");
    expect(response.verdict).to.equal("DENY");
  });
});

describe("the simulated evidence class", () => {
  it("ranks below static-registry and onchain-read, above caller-stated", () => {
    const weight = EVIDENCE_CLASS_WEIGHTS;
    expect(weight.simulated).to.be.below(weight["static-registry"]);
    expect(weight.simulated).to.be.below(weight["onchain-read"]);
    expect(weight.simulated).to.be.above(weight["caller-stated"]);
  });
});
