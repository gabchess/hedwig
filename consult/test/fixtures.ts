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
    },
    ...overrides,
  };
}

export const PASSING_EXTRA_CONDITION_ID = "memo-recorded";

const passingExtraCondition: ConditionDefinition = {
  id: PASSING_EXTRA_CONDITION_ID,
  isFloor: false,
  check: () => ({
    id: PASSING_EXTRA_CONDITION_ID,
    status: "PASS",
    evidence: "test-only condition used to prove passes never override UNKNOWN",
  }),
};

export const CATALOG_WITH_EXTRA_CONDITION: Catalog = {
  pay: [...PAY_CATALOG.pay, passingExtraCondition],
};
