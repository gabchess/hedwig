import {
  CANONICAL_ASSET_ADDRESS,
  CANONICAL_ASSET_SYMBOL,
  CANONICAL_CHAIN_ID,
  PAY_CATALOG,
  POISON_FLAGGED_RECIPIENT,
} from "../src/catalog";
import type {
  Catalog,
  ConditionDefinition,
  ConsultRequest,
  Policy,
} from "../src/catalog";

export const CHAIN_ID = CANONICAL_CHAIN_ID;
export const ASSET_SYMBOL = CANONICAL_ASSET_SYMBOL;
export const ASSET_ADDRESS = CANONICAL_ASSET_ADDRESS;
export const POISONED_RECIPIENT = POISON_FLAGGED_RECIPIENT;

// Full 40-hex-digit EVM addresses: consult() validates recipient shape
// strictly, so a fixture short of that shape resolves to UNVERIFIED rather
// than PASS or FAIL, which would silently break every test that uses it.
export const APPROVED_RECIPIENT = "0x00000000000000000000000000000000a11ce001";
export const UNAPPROVED_RECIPIENT =
  "0x00000000000000000000000000000000badc0de0";

export function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    permits: true,
    chainId: CHAIN_ID,
    approvedRecipients: [APPROVED_RECIPIENT],
    perActionCaps: { pay: "1000000" },
    ...overrides,
  };
}

export function makeRequest(
  overrides: Partial<ConsultRequest> = {}
): ConsultRequest {
  return {
    action: {
      type: "pay",
      chainId: CHAIN_ID,
      recipient: APPROVED_RECIPIENT,
      asset: { symbol: ASSET_SYMBOL, contractAddress: ASSET_ADDRESS },
      amount: "1000000",
      target: ASSET_ADDRESS,
    },
    ...overrides,
  };
}

export const PASSING_EXTRA_CONDITION_ID = "memo-recorded";

const passingExtraCondition: ConditionDefinition = {
  id: PASSING_EXTRA_CONDITION_ID,
  isFloor: false,
  question: "Was a memo recorded for this payment?",
  reference: "consult/references/core.md",
  codes: {
    pass: "MEMO_RECORDED",
    fail: ["MEMO_MISSING"],
    unverified: ["MEMO_CHECK_UNAVAILABLE"],
  },
  codeEvidenceClass: {
    MEMO_RECORDED: "owner-policy",
    MEMO_MISSING: "owner-policy",
    MEMO_CHECK_UNAVAILABLE: "not-verifiable",
  },
  check: () => ({
    id: PASSING_EXTRA_CONDITION_ID,
    status: "PASS",
    code: "MEMO_RECORDED",
    evidenceClass: "owner-policy",
    evidence: "test-only condition used to prove passes never override UNKNOWN",
  }),
};

export const CATALOG_WITH_EXTRA_CONDITION: Catalog = {
  pay: [...PAY_CATALOG.pay, passingExtraCondition],
};

// A minimal, valid ConditionDefinition for tests that only care about
// checker behaviour (a throw, a duplicate id, a call counter): every field
// the catalog lint would otherwise flag is filled in with a generic,
// globally-unique-enough placeholder so consultWith's own validation never
// masks what the test is actually proving. Override `codes` explicitly
// whenever a test builds more than one of these into the same catalog.
export function testCondition(
  overrides: Pick<ConditionDefinition, "id" | "isFloor" | "check"> &
    Partial<ConditionDefinition>
): ConditionDefinition {
  return {
    question: `Test-only condition: does ${overrides.id} pass?`,
    reference: "consult/references/core.md",
    codes: {
      pass: "TEST_PASS",
      fail: ["TEST_FAIL"],
      unverified: ["TEST_UNVERIFIED"],
    },
    codeEvidenceClass: {
      TEST_PASS: "owner-policy",
      TEST_FAIL: "owner-policy",
      TEST_UNVERIFIED: "not-verifiable",
    },
    ...overrides,
  };
}

// The real recipient-matches-policy Condition, minus its checker: used by
// tests that swap in a hostile or instrumented check function while
// keeping the real question, reference, and declared codes, exactly as
// consultWith would see them for the real Condition.
export const RECIPIENT_MATCHES_POLICY_DEFINITION = PAY_CATALOG.pay.find(
  (condition) => condition.id === "recipient-matches-policy"
)!;
