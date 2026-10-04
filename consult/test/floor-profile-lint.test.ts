import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import { CATALOG, readSlippageShape, validateCatalog } from "../src/catalog";
import type {
  Catalog,
  ConditionDefinition,
  ConsultRequest,
  Policy,
} from "../src/catalog";
import {
  FLOOR_PROFILE,
  SLIPPAGE_FLOOR_ID,
  TAX_RULE_ID,
  validateFloorProfile,
} from "../src/floor-profile";
import { PARAM_READS, paramReadViolations, paramReader } from "../src/params";
import { makeRequest } from "./fixtures";
import {
  BRIDGED_USDT,
  BASE_CHAIN_ID,
  CAP,
  ETHEREUM_USDT,
  NOW,
  SLIPPAGE_FILE,
  UNKNOWN_FILE,
  floorBundle,
  healthySignals,
  payOf,
  swapAt,
  swapFacts,
  swapOf,
  taxEntry,
  UNLISTED_TOKEN,
  USDC_TAX,
  usdtRegistryFact,
} from "./floor-fixtures";

const REPO_ROOT = join(__dirname, "..", "..");
const CODE_SHAPE = /^[A-Z][A-Z0-9_]+$/;
// The fixture bundle's own labels a Check may not read, plus a label the
// package does not name: the service owns the label set.
const NOT_CHECK_LABELS = [
  "fixture-label-not-check",
  "fixture-label-unassigned",
  "next",
];

type Pair = readonly [string, string];

// The lint under test, as a function over any profile. A profile is clean
// when it returns no violation. Three rules:
//  1. declared: no member declares or is known to read a policy field;
//  2. observed: no member touches `context.policy`, whatever it declares;
//  3. ceiling: each ceiling member reads at least one constant, and every
//     constant any member reads is a listed pair labelled check or both.
interface Probe {
  request: ConsultRequest;
  facts: unknown;
}

const payProbe = (): Probe => ({
  request: payOf("USDT", BRIDGED_USDT, BASE_CHAIN_ID),
  facts: {
    now: NOW,
    marketSignals: healthySignals(BASE_CHAIN_ID, BRIDGED_USDT),
  },
});
const knownPayProbe = (): Probe => ({
  request: payOf("USDT", ETHEREUM_USDT),
  facts: { now: NOW, registryAsset: usdtRegistryFact() },
});
const swapProbe = (): Probe => ({
  request: swapAt(CAP - 1),
  facts: swapFacts(),
});
const unknownSwapProbe = (): Probe => ({
  request: swapOf(UNLISTED_TOKEN),
  facts: swapFacts([
    USDC_TAX,
    taxEntry(UNLISTED_TOKEN.contractAddress, { source: "simulation" }),
  ]),
});
const PROBES: Probe[] = [
  payProbe(),
  knownPayProbe(),
  swapProbe(),
  unknownSwapProbe(),
  { request: makeRequest(), facts: undefined },
  { request: { action: { type: "swap", chainId: "x" } }, facts: {} },
];

// A policy that records every way a checker can look at it.
function recordingPolicy(touched: string[]): Policy {
  const note = (what: string, key: PropertyKey) =>
    touched.push(`${what} ${String(key)}`);
  return new Proxy(
    {},
    {
      get(_target, key) {
        note("get", key);
        return undefined;
      },
      has(_target, key) {
        note("has", key);
        return false;
      },
      ownKeys() {
        note("ownKeys", "*");
        return [];
      },
      getOwnPropertyDescriptor(_target, key) {
        note("descriptor", key);
        return undefined;
      },
    }
  ) as Policy;
}

function policyTouches(catalog: Catalog): string[] {
  const touched: string[] = [];
  for (const conditions of Object.values(catalog)) {
    for (const condition of conditions) {
      for (const probe of PROBES) {
        const before = touched.length;
        try {
          condition.check(probe.request, {
            policy: recordingPolicy(touched),
            facts: probe.facts,
            param: () => undefined,
          });
        } catch {
          // A checker that throws on a probe shape is not a policy read.
        }
        touched
          .splice(before)
          .forEach((what) => touched.push(`${condition.id}: ${what}`));
      }
    }
  }
  return [...new Set(touched)];
}

// Every [params id, key] a member asks the reader for across the probes,
// with the member that asked.
function paramReads(
  catalog: Catalog,
  bundle: unknown
): { id: string; pair: Pair }[] {
  const reads: { id: string; pair: Pair }[] = [];
  for (const conditions of Object.values(catalog)) {
    for (const condition of conditions) {
      for (const probe of PROBES) {
        const reader = paramReader(bundle, PARAM_READS);
        try {
          condition.check(probe.request, {
            policy: {} as Policy,
            facts: probe.facts,
            param: (paramsId, key) => {
              reads.push({ id: condition.id, pair: [paramsId, key] });
              return reader(paramsId, key);
            },
          });
        } catch {
          // Not a read.
        }
      }
    }
  }
  return reads;
}

// A ceiling member that never asks for a constant has its number spelled in
// code. Probed on a request that reaches the comparison.
function ceilingViolations(
  catalog: Catalog,
  ceilingIds: readonly string[],
  bundle: unknown
): string[] {
  const reads = paramReads(catalog, bundle);
  const listed = (pair: Pair) =>
    PARAM_READS.some(([id, key]) => id === pair[0] && key === pair[1]);
  return [
    ...ceilingIds
      .filter((id) => !reads.some((read) => read.id === id))
      .map((id) => `${id}: reads no constant through context.param`),
    ...reads
      .filter((read) => !listed(read.pair))
      .map((read) => `${read.id}: reads ${read.pair.join(" ")}, not listed`),
    ...paramReadViolations(
      [
        ...new Map(
          reads.map((read) => [read.pair.join("|"), read.pair])
        ).values(),
      ],
      bundle
    ),
  ];
}

const lint = (
  catalog: Catalog,
  ceilingIds = [SLIPPAGE_FLOOR_ID, TAX_RULE_ID]
) => [
  ...[validateFloorProfile(catalog)].filter(
    (x): x is string => x !== undefined
  ),
  ...policyTouches(catalog),
  ...ceilingViolations(catalog, ceilingIds, floorBundle()),
];

const owner = (id: string) =>
  CATALOG.swap.find((condition) => condition.id === id)!;
const slippageFloor = () =>
  FLOOR_PROFILE.swap.find((condition) => condition.id === SLIPPAGE_FLOOR_ID)!;

// A copy of the real profile with one swap member added or replaced.
function withSwap(
  change: (members: readonly ConditionDefinition[]) => ConditionDefinition[]
): Catalog {
  return { ...FLOOR_PROFILE, swap: change(FLOOR_PROFILE.swap) };
}

describe("floor profile lint: the real profile is clean", () => {
  it("passes all three rules", () => {
    expect(lint(FLOOR_PROFILE)).to.deep.equal([]);
  });

  it("is a sound catalog on its own, and the real catalog still is", () => {
    expect(validateCatalog(FLOOR_PROFILE)).to.equal(undefined);
    expect(validateFloorProfile(FLOOR_PROFILE)).to.equal(undefined);
    expect(validateCatalog(CATALOG)).to.equal(undefined);
  });

  it("every code is SCREAMING_SNAKE_CASE and every member has a reference file", () => {
    for (const condition of [...FLOOR_PROFILE.pay, ...FLOOR_PROFILE.swap]) {
      const codes = [
        ...(Array.isArray(condition.codes.pass)
          ? condition.codes.pass
          : [condition.codes.pass as string]),
        ...condition.codes.fail,
        ...condition.codes.unverified,
      ];
      codes.forEach((code) => expect(code).to.match(CODE_SHAPE));
      const path = join(REPO_ROOT, condition.reference);
      expect(existsSync(path), condition.reference).to.equal(true);
      expect(readFileSync(path, "utf8").trim(), condition.reference).to.not.be
        .empty;
    }
  });

  it("reads exactly the four new constants on a swap, and eight market constants on a pay", () => {
    const swapReads = paramReads({ swap: FLOOR_PROFILE.swap }, floorBundle());
    expect(
      [...new Set(swapReads.map((read) => read.pair.join(" ")))].sort()
    ).to.deep.equal(
      [
        [SLIPPAGE_FILE, "tolerance_cap_deny_above_bps"],
        [SLIPPAGE_FILE, "tolerance_floor_bps"],
        [SLIPPAGE_FILE, "tax_plus_honest_tolerance_max_bps"],
        [UNKNOWN_FILE, "tax_plus_honest_tolerance_deny_above_bps"],
      ]
        .map((pair) => pair.join(" "))
        .sort()
    );
    const payReads = paramReads({ pay: FLOOR_PROFILE.pay }, floorBundle());
    expect(new Set(payReads.map((read) => read.pair[1])).size).to.equal(8);
    expect(payReads.every((read) => read.pair[0] === UNKNOWN_FILE)).to.equal(
      true
    );
  });

  it("the new members are in none of the owner catalog's tables", () => {
    for (const id of [SLIPPAGE_FLOOR_ID, TAX_RULE_ID]) {
      expect(
        Object.values(CATALOG)
          .flat()
          .map((c) => c.id)
      ).to.not.include(id);
    }
  });
});

describe("floor profile lint: planted violations fail it", () => {
  it("rule 1: a profile that carries a policy-reading owner Condition", () => {
    const planted = withSwap((members) => [
      ...members,
      owner("slippage-within-ceiling"),
    ]);
    expect(validateFloorProfile(planted)).to.be.a("string");
    expect(lint(planted)).to.not.deep.equal([]);
    for (const id of [
      "deadline-set-and-fresh",
      "output-recipient-is-owner",
      "amount-within-cap",
      "chain-matches-intent",
      "role-requirement-met",
    ]) {
      const bad = withSwap((members) => [...members, owner(id)]);
      expect(validateFloorProfile(bad), id).to.be.a("string");
    }
  });

  it("rule 1: a member that declares a policy field", () => {
    const planted = withSwap((members) =>
      members.map((member) =>
        member.id === "approval-scoped-to-this-swap"
          ? { ...member, policyFields: ["anything"] }
          : member
      )
    );
    expect(validateFloorProfile(planted)).to.match(/declares a policy field/);
  });

  it("rule 1: a known policy reader with its declared fields blanked is refused by the catalog check beneath", () => {
    const planted = withSwap((members) => [
      ...members,
      { ...owner("output-recipient-is-owner"), policyFields: [] },
    ]);
    expect(validateFloorProfile(planted)).to.match(/declares no policyFields/);
  });

  it("rule 1: a profile that is not a sound catalog is refused", () => {
    const duplicate = withSwap((members) => [...members, members[0]]);
    expect(validateFloorProfile(duplicate)).to.match(/duplicate Condition id/);
    expect(validateFloorProfile({ swap: "no" })).to.be.a("string");
    expect(validateFloorProfile(null)).to.be.a("string");
  });

  it("rule 1: a member that is not a Floor member", () => {
    const planted = withSwap((members) =>
      members.map((member) =>
        member.id === TAX_RULE_ID ? { ...member, isFloor: false } : member
      )
    );
    expect(validateFloorProfile(planted)).to.match(/not a Floor member/);
  });

  it("rule 2: a member that reads a policy field it never declared", () => {
    const sneaky: ConditionDefinition = {
      ...slippageFloor(),
      check: (request, context) => {
        const ceiling = context.policy.maxSlippageBps;
        return {
          id: SLIPPAGE_FLOOR_ID,
          status: ceiling === undefined ? "UNVERIFIED" : "PASS",
          code:
            ceiling === undefined
              ? "SWAP_FLOOR_CEILING_MISSING"
              : "SWAP_FLOOR_SLIPPAGE_WITHIN_CEILING",
          evidenceClass: "caller-stated",
          evidence: String(request.action.type),
        };
      },
    };
    const planted = withSwap((members) =>
      members.map((m) => (m.id === SLIPPAGE_FLOOR_ID ? sneaky : m))
    );
    expect(validateFloorProfile(planted)).to.equal(undefined);
    expect(policyTouches(planted)).to.include(
      `${SLIPPAGE_FLOOR_ID}: get maxSlippageBps`
    );
    expect(lint(planted)).to.not.deep.equal([]);
  });

  it("rule 2: a member that only checks a policy field exists, or lists its keys", () => {
    for (const probe of [
      (policy: Policy) => "maxSlippageBps" in policy,
      (policy: Policy) => Object.keys(policy).length,
      (policy: Policy) => JSON.stringify(policy),
    ]) {
      const sneaky: ConditionDefinition = {
        ...slippageFloor(),
        check: (request, context) => {
          probe(context.policy);
          return slippageFloor().check(request, context);
        },
      };
      const planted = withSwap((members) =>
        members.map((m) => (m.id === SLIPPAGE_FLOOR_ID ? sneaky : m))
      );
      expect(policyTouches(planted).length).to.be.greaterThan(0);
    }
  });

  it("rule 3: a ceiling spelled in code instead of read through context.param", () => {
    const literal: ConditionDefinition = {
      ...slippageFloor(),
      check: (request) => {
        const shape = readSlippageShape(
          SLIPPAGE_FLOOR_ID,
          request,
          {
            amountsMalformed: "SWAP_FLOOR_AMOUNTS_MALFORMED",
            quotedOutZero: "SWAP_FLOOR_QUOTED_OUT_ZERO",
            minOutZero: "SWAP_FLOOR_MIN_OUT_ZERO",
            minOutExceedsQuote: "SWAP_FLOOR_MIN_OUT_EXCEEDS_QUOTE",
            bpsMalformed: "SWAP_FLOOR_BPS_MALFORMED",
            declaredMismatch: "SWAP_FLOOR_DECLARED_MISMATCH",
          },
          "caller-stated",
          "the floor allows"
        );
        if ("status" in shape) {
          return shape;
        }
        const within = shape.derivedBps <= 77n;
        return {
          id: SLIPPAGE_FLOOR_ID,
          status: within ? "PASS" : "FAIL",
          code: within
            ? "SWAP_FLOOR_SLIPPAGE_WITHIN_CEILING"
            : "SWAP_FLOOR_SLIPPAGE_EXCEEDS_CEILING",
          evidenceClass: "caller-stated",
          evidence: "literal ceiling",
        };
      },
    };
    const planted = withSwap((members) =>
      members.map((m) => (m.id === SLIPPAGE_FLOOR_ID ? literal : m))
    );
    expect(
      ceilingViolations(planted, [SLIPPAGE_FLOOR_ID], floorBundle())
    ).to.deep.equal([
      `${SLIPPAGE_FLOOR_ID}: reads no constant through context.param`,
    ]);
    expect(lint(planted)).to.not.deep.equal([]);
  });

  it("rule 3: a member that reads a constant no listed pair covers", () => {
    const unlisted: ConditionDefinition = {
      ...slippageFloor(),
      check: (request, context) => {
        context.param(SLIPPAGE_FILE, "price_impact_deny_above_bps");
        return slippageFloor().check(request, context);
      },
    };
    const planted = withSwap((members) =>
      members.map((m) => (m.id === SLIPPAGE_FLOOR_ID ? unlisted : m))
    );
    // The reader refuses it, so it reads as missing; the lint names it.
    expect(
      ceilingViolations(planted, [SLIPPAGE_FLOOR_ID], floorBundle())
    ).to.include(
      `${SLIPPAGE_FLOOR_ID}: reads ${SLIPPAGE_FILE} price_impact_deny_above_bps, not listed`
    );
  });

  it("rule 3: a constant labelled for anything but check or both fails the used-by lint", () => {
    for (const label of NOT_CHECK_LABELS) {
      for (const [file, key] of [
        [SLIPPAGE_FILE, "tolerance_cap_deny_above_bps"],
        [SLIPPAGE_FILE, "tolerance_floor_bps"],
        [SLIPPAGE_FILE, "tax_plus_honest_tolerance_max_bps"],
        [UNKNOWN_FILE, "tax_plus_honest_tolerance_deny_above_bps"],
      ]) {
        const bundle = floorBundle((b) => {
          b[file][key].used_by = label;
        });
        expect(
          paramReadViolations(PARAM_READS, bundle),
          `${label} ${key}`
        ).to.deep.equal([`${file} ${key}: labelled ${label}`]);
      }
    }
  });

  it("the clean bundle passes the used-by lint for every listed read", () => {
    expect(paramReadViolations(PARAM_READS, floorBundle())).to.deep.equal([]);
  });
});

describe("floor profile lint: the lint is not vacuous on the real owner catalog", () => {
  it("run over the owner's swap catalog, rule 1 and rule 2 both find its policy readers", () => {
    expect(validateFloorProfile(CATALOG)).to.be.a("string");
    const touched = policyTouches({ swap: CATALOG.swap });
    expect(
      touched.some((t) => t.startsWith("slippage-within-ceiling:"))
    ).to.equal(true);
    expect(
      touched.some((t) => t.startsWith("deadline-set-and-fresh:"))
    ).to.equal(true);
  });

  it("does not flag the owner's shared members that read no policy", () => {
    const touched = policyTouches({
      swap: [owner("approval-scoped-to-this-swap")],
    });
    expect(touched).to.deep.equal([]);
  });
});
