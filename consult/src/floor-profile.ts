// The floor profile: a code-owned list of the Conditions that read no policy
// field, so a caller with no policy file still gets a real check. It is its
// own catalog, bound once at module load. A caller cannot supply, edit or
// remove it, and `consult()` never sees it: the two Conditions that exist
// only here (a params slippage ceiling and the token transfer tax rule) are
// not in CATALOG, because the owner path has no params bundle and they would
// turn every local swap UNKNOWN.
//
// Shipped Conditions that read a policy field stay in the owner layer,
// unchanged: for pay, recipient-matches-policy, amount-within-cap,
// chain-matches-intent, role-requirement-met and
// authorization-window-within-ceiling; for swap, slippage-within-ceiling,
// deadline-set-and-fresh, output-recipient-is-owner, amount-within-cap,
// chain-matches-intent and role-requirement-met. The profile reuses the
// other shipped definitions as they are, so their codes, evidence classes
// and references stay identical.
import {
  CATALOG,
  deepFreeze,
  describe,
  isAmount,
  isUnixSecond,
  isWholeBps,
  ownLookup,
  readFactNow,
  readSlippageShape,
  sameEvmAddress,
  slippageWithin,
  tokenKnownTo,
  validateCatalog,
} from "./catalog";
import type {
  Catalog,
  ConditionContext,
  ConditionDefinition,
  ConsultRequest,
  Policy,
} from "./catalog";
import { makeConsult } from "./core";
import type { ConsultResponse } from "./core";
import { MAX_TAX_READING_AGE_SECONDS } from "./constants";
import type { CheckerOutcome } from "./fold";
import { SLIPPAGE_MEV_PARAMS_ID, UNKNOWN_TOKEN_PARAMS_ID } from "./params";

const SWAP_REFERENCE_ROOT = "consult/references/swap";

export const SLIPPAGE_FLOOR_ID = "slippage-within-floor-ceiling";
export const TAX_RULE_ID = "token-tax-within-bound";

// -- the slippage ceiling, from the params bundle --------------------------

// The same request checks as the owner's slippage Condition, with the ceiling
// read through context.param instead of the policy. A zero minOut fails here
// whatever the ceiling, and a missing ceiling is UNVERIFIED.
function checkSlippageWithinFloorCeiling(
  request: ConsultRequest,
  context: ConditionContext
): CheckerOutcome {
  const id = SLIPPAGE_FLOOR_ID;
  const shape = readSlippageShape(
    id,
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

  const ceiling = context.param(
    SLIPPAGE_MEV_PARAMS_ID,
    "tolerance_cap_deny_above_bps"
  )?.value;
  if (!isWholeBps(ceiling)) {
    return {
      id,
      status: "UNVERIFIED",
      code: "SWAP_FLOOR_CEILING_MISSING",
      evidenceClass: "not-verifiable",
      evidence:
        "the slippage ceiling is not in the params bundle as a whole number of basis points",
    };
  }

  const within = slippageWithin(shape, ceiling);
  return {
    id,
    status: within ? "PASS" : "FAIL",
    code: within
      ? "SWAP_FLOOR_SLIPPAGE_WITHIN_CEILING"
      : "SWAP_FLOOR_SLIPPAGE_EXCEEDS_CEILING",
    evidenceClass: "caller-stated",
    evidence: within
      ? `slippage against the stated quote is ${shape.derivedBps.toString()} bps, within the ceiling ${describe(
          ceiling
        )}`
      : `slippage against the stated quote is at least ${shape.derivedBps.toString()} bps, above the ceiling ${describe(
          ceiling
        )}`,
  };
}

const SLIPPAGE_FLOOR: ConditionDefinition = {
  id: SLIPPAGE_FLOOR_ID,
  isFloor: true,
  question: "Is the swap's slippage within the floor's ceiling?",
  reference: `${SWAP_REFERENCE_ROOT}/${SLIPPAGE_FLOOR_ID}.md`,
  codes: {
    pass: "SWAP_FLOOR_SLIPPAGE_WITHIN_CEILING",
    fail: [
      "SWAP_FLOOR_SLIPPAGE_EXCEEDS_CEILING",
      "SWAP_FLOOR_AMOUNTS_MALFORMED",
      "SWAP_FLOOR_QUOTED_OUT_ZERO",
      "SWAP_FLOOR_MIN_OUT_ZERO",
      "SWAP_FLOOR_MIN_OUT_EXCEEDS_QUOTE",
      "SWAP_FLOOR_BPS_MALFORMED",
      "SWAP_FLOOR_DECLARED_MISMATCH",
    ],
    unverified: ["SWAP_FLOOR_CEILING_MISSING"],
  },
  codeEvidenceClass: {
    SWAP_FLOOR_SLIPPAGE_WITHIN_CEILING: "caller-stated",
    SWAP_FLOOR_SLIPPAGE_EXCEEDS_CEILING: "caller-stated",
    SWAP_FLOOR_AMOUNTS_MALFORMED: "caller-stated",
    SWAP_FLOOR_QUOTED_OUT_ZERO: "caller-stated",
    SWAP_FLOOR_MIN_OUT_ZERO: "caller-stated",
    SWAP_FLOOR_MIN_OUT_EXCEEDS_QUOTE: "caller-stated",
    SWAP_FLOOR_BPS_MALFORMED: "caller-stated",
    SWAP_FLOOR_DECLARED_MISMATCH: "caller-stated",
    SWAP_FLOOR_CEILING_MISSING: "not-verifiable",
  },
  policyFields: [],
  check: checkSlippageWithinFloorCeiling,
};

// -- the token transfer tax rule -------------------------------------------

type Leg = {
  readonly label: "tokenIn" | "tokenOut";
  readonly symbol: unknown;
  readonly address: unknown;
};

function legOf(request: ConsultRequest, label: Leg["label"]): Leg {
  const token = ownLookup<unknown>(request.action, label);
  return {
    label,
    symbol: ownLookup<unknown>(token, "symbol"),
    address: ownLookup<unknown>(token, "contractAddress"),
  };
}

// Every facts.tokenTax entry about this leg: the same chain and the same
// address, compared as bytes. Nothing else about an entry is read here.
function entriesFor(facts: unknown, chainId: unknown, leg: Leg): unknown[] {
  const list = ownLookup<unknown>(facts, "tokenTax");
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter(
    (entry) =>
      ownLookup<unknown>(entry, "chainId") === chainId &&
      sameEvmAddress(ownLookup<unknown>(entry, "address"), leg.address) === true
  );
}

const unverified = (code: string, evidence: string): CheckerOutcome => ({
  id: TAX_RULE_ID,
  status: "UNVERIFIED",
  code,
  evidenceClass: "not-verifiable",
  evidence,
});

// A swap pays the tax of both legs out of one trade, so the rule adds the
// two taxes to the honest tolerance and compares the total with one bound.
// The bound is the known-token constant when both legs are named by the code
// table or a confirmed registry row at their exact address, else the
// unknown-token constant. Order: a sellBlocked entry denies first, before any
// constant or clock is read; then every leg needs one well-formed, fresh
// entry; then both constants; then the sum.
function checkTokenTaxWithinBound(
  request: ConsultRequest,
  context: ConditionContext
): CheckerOutcome {
  const chainId = request.action.chainId;
  const legs = [legOf(request, "tokenIn"), legOf(request, "tokenOut")];
  const found = legs.map((leg) => entriesFor(context.facts, chainId, leg));

  for (const [i, leg] of legs.entries()) {
    if (found[i].some((entry) => ownLookup(entry, "sellBlocked") === true)) {
      return {
        id: TAX_RULE_ID,
        status: "FAIL",
        code: "SWAP_TOKEN_SELL_BLOCKED",
        evidenceClass: "simulated",
        evidence: `a probe could not sell ${leg.label} ${describe(
          leg.address
        )} after buying it`,
      };
    }
  }

  const now = readFactNow(context.facts);
  const taxes: number[] = [];
  let canonical = true;
  let known = true;
  for (const [i, leg] of legs.entries()) {
    if (found[i].length === 0) {
      return unverified(
        "SWAP_TAX_FACT_MISSING",
        `no tax reading for ${leg.label} ${describe(leg.address)}`
      );
    }
    if (found[i].length > 1) {
      return unverified(
        "SWAP_TAX_FACT_AMBIGUOUS",
        `more than one tax reading for ${leg.label} ${describe(leg.address)}`
      );
    }
    const entry = found[i][0];
    const taxBps = ownLookup<unknown>(entry, "taxBps");
    const sellBlocked = ownLookup<unknown>(entry, "sellBlocked");
    const asOf = ownLookup<unknown>(entry, "asOf");
    const source = ownLookup<unknown>(entry, "source");
    if (
      !isWholeBps(taxBps) ||
      typeof sellBlocked !== "boolean" ||
      !isUnixSecond(asOf) ||
      (source !== "simulation" && source !== "canonical")
    ) {
      return unverified(
        "SWAP_TAX_FACT_MALFORMED",
        `the tax reading for ${leg.label} is not well formed`
      );
    }
    const legKnown = tokenKnownTo(
      chainId,
      leg.symbol,
      leg.address,
      context.facts
    );
    if (source === "canonical" && !(legKnown && taxBps === 0)) {
      return unverified(
        "SWAP_TAX_CANONICAL_UNCONFIRMED",
        `a canonical tax reading for ${leg.label} needs the token named at this address and a tax of 0`
      );
    }
    if (now === undefined || asOf > now) {
      return unverified(
        "SWAP_TAX_AGE_UNKNOWN",
        `the age of the tax reading for ${leg.label} cannot be placed`
      );
    }
    if (now - asOf > MAX_TAX_READING_AGE_SECONDS) {
      return unverified(
        "SWAP_TAX_FACT_STALE",
        `the tax reading for ${leg.label} is older than ${MAX_TAX_READING_AGE_SECONDS} seconds`
      );
    }
    taxes.push(taxBps);
    canonical = canonical && source === "canonical";
    known = known && legKnown;
  }

  const boundValue = (
    known
      ? context.param(
          SLIPPAGE_MEV_PARAMS_ID,
          "tax_plus_honest_tolerance_max_bps"
        )
      : context.param(
          UNKNOWN_TOKEN_PARAMS_ID,
          "tax_plus_honest_tolerance_deny_above_bps"
        )
  )?.value;
  const toleranceValue = context.param(
    SLIPPAGE_MEV_PARAMS_ID,
    "tolerance_floor_bps"
  )?.value;
  if (!isAmount(boundValue) || !isAmount(toleranceValue)) {
    return unverified(
      "SWAP_TAX_BOUND_MISSING",
      "the tax bound or the honest tolerance floor is not in the params bundle as a number"
    );
  }

  const total = taxes[0] + taxes[1] + toleranceValue;
  const within = total <= boundValue;
  const evidence = `tax ${describe(taxes[0])} + ${describe(
    taxes[1]
  )} bps plus the tolerance floor ${describe(toleranceValue)} is ${describe(
    total
  )} bps, ${within ? "within" : "above"} the bound ${describe(boundValue)}`;
  const code = !within
    ? "SWAP_TAX_EXCEEDS_BOUND"
    : canonical
    ? "SWAP_TAX_WITHIN_BOUND_CANONICAL"
    : "SWAP_TAX_WITHIN_BOUND_SIMULATED";
  return {
    id: TAX_RULE_ID,
    status: within ? "PASS" : "FAIL",
    code,
    evidenceClass: TAX_RULE.codeEvidenceClass[code],
    evidence,
  };
}

const TAX_RULE: ConditionDefinition = {
  id: TAX_RULE_ID,
  isFloor: true,
  question:
    "Do the swap tokens' transfer taxes plus honest tolerance stay within the bound?",
  reference: `${SWAP_REFERENCE_ROOT}/${TAX_RULE_ID}.md`,
  codes: {
    pass: [
      "SWAP_TAX_WITHIN_BOUND_CANONICAL",
      "SWAP_TAX_WITHIN_BOUND_SIMULATED",
    ],
    fail: ["SWAP_TAX_EXCEEDS_BOUND", "SWAP_TOKEN_SELL_BLOCKED"],
    unverified: [
      "SWAP_TAX_FACT_MISSING",
      "SWAP_TAX_FACT_AMBIGUOUS",
      "SWAP_TAX_FACT_MALFORMED",
      "SWAP_TAX_CANONICAL_UNCONFIRMED",
      "SWAP_TAX_AGE_UNKNOWN",
      "SWAP_TAX_FACT_STALE",
      "SWAP_TAX_BOUND_MISSING",
    ],
  },
  codeEvidenceClass: {
    SWAP_TAX_WITHIN_BOUND_CANONICAL: "static-registry",
    SWAP_TAX_WITHIN_BOUND_SIMULATED: "simulated",
    SWAP_TAX_EXCEEDS_BOUND: "simulated",
    SWAP_TOKEN_SELL_BLOCKED: "simulated",
    SWAP_TAX_FACT_MISSING: "not-verifiable",
    SWAP_TAX_FACT_AMBIGUOUS: "not-verifiable",
    SWAP_TAX_FACT_MALFORMED: "not-verifiable",
    SWAP_TAX_CANONICAL_UNCONFIRMED: "not-verifiable",
    SWAP_TAX_AGE_UNKNOWN: "not-verifiable",
    SWAP_TAX_FACT_STALE: "not-verifiable",
    SWAP_TAX_BOUND_MISSING: "not-verifiable",
  },
  policyFields: [],
  check: checkTokenTaxWithinBound,
};

// -- the profile ------------------------------------------------------------

function member(
  conditions: readonly ConditionDefinition[],
  id: string
): ConditionDefinition {
  const found = conditions.find((condition) => condition.id === id);
  if (found === undefined) {
    throw new Error(
      `floor profile names a Condition that is not shipped: ${id}`
    );
  }
  return found;
}

export const FLOOR_PROFILE: Catalog = deepFreeze({
  pay: [
    "recipient-not-poison-derived",
    "asset-is-canonical",
    "target-is-canonical",
    "asset-liquidity-sufficient",
    "asset-holders-sufficient",
    "asset-activity-sufficient",
  ].map((id) => member(CATALOG.pay, id)),
  swap: [
    ...[
      "target-is-canonical",
      "token-in-is-canonical",
      "token-out-is-canonical",
      "approval-scoped-to-this-swap",
    ].map((id) => member(CATALOG.swap, id)),
    SLIPPAGE_FLOOR,
    TAX_RULE,
  ],
});

// The first defect in a profile, or undefined. Beyond validateCatalog, a
// profile member must be a Floor member and must declare no policy field.
// validateCatalog already refuses a known policy reader with no declared
// field, so a policy reader in the profile cannot hide behind an empty list.
export function validateFloorProfile(profile: unknown): string | undefined {
  const defect = validateCatalog(profile);
  if (defect !== undefined) {
    return defect;
  }
  for (const conditions of Object.values(profile as Catalog)) {
    for (const condition of conditions) {
      if (condition.isFloor !== true) {
        return `floor profile Condition "${condition.id}" is not a Floor member`;
      }
      if ((condition.policyFields ?? []).length > 0) {
        return `floor profile Condition "${condition.id}" declares a policy field`;
      }
    }
  }
  return undefined;
}

const profileDefect = validateFloorProfile(FLOOR_PROFILE);
if (profileDefect !== undefined) {
  throw new Error(profileDefect);
}

// No policy field is read, so the policy the core folds with is fixed here:
// it permits, and the verdict rests on the Checks alone.
const FLOOR_POLICY = deepFreeze({ permits: true }) as unknown as Policy;
const runFloor = makeConsult(FLOOR_PROFILE);

/**
 * Runs the floor profile for a caller with no policy. Same contract as
 * `consult`: never throws, never touches the network, reads `facts` as data.
 * ALLOW_UNDER_POLICY here means allowed under the fixed floor.
 */
export function consultFloor(
  request: ConsultRequest,
  facts?: unknown
): ConsultResponse {
  return runFloor(request, FLOOR_POLICY, facts);
}
