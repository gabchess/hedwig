import type { ConditionResult } from "./fold";

export interface Policy {
  permits: boolean;
  chainId: string;
  approvedRecipients: string[];
  perActionCaps: Record<string, string>;
}

export interface ConsultAction {
  type: string;
  chainId: string;
  recipient: string;
  asset: { symbol: string; contractAddress: string };
  amount: string;
}

export interface ConsultRequest {
  action: ConsultAction;
  conditions?: string[];
}

export interface ConditionContext {
  policy: Policy;
}

export type ConditionChecker = (
  request: ConsultRequest,
  context: ConditionContext
) => ConditionResult;

export interface ConditionDefinition {
  id: string;
  isFloor: boolean;
  check: ConditionChecker;
}

export type Catalog = Record<string, ConditionDefinition[]>;

// Fixed tables the checkers below read from directly, so consult() never
// makes a network or RPC call to answer a Condition.
export const CANONICAL_CHAIN_ID = "eip155:1";
export const CANONICAL_ASSET_SYMBOL = "USDC";
export const CANONICAL_ASSET_ADDRESS =
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const CANONICAL_ASSETS: Record<string, Record<string, string>> = {
  [CANONICAL_CHAIN_ID]: { [CANONICAL_ASSET_SYMBOL]: CANONICAL_ASSET_ADDRESS },
};

export const POISON_FLAGGED_RECIPIENT =
  "0x00000000000000000000000000000000BAD001";

const POISONED_RECIPIENTS = new Set<string>([POISON_FLAGGED_RECIPIENT]);

function checkRecipientMatchesPolicy(
  request: ConsultRequest,
  context: ConditionContext
): ConditionResult {
  // Byte-exact comparison only: Array#includes uses strict equality, no case
  // folding or checksum normalisation. The Floor requires an exact match
  // against an owner-approved entry, and a differently-cased or truncated
  // lookalike must fail.
  const matched = context.policy.approvedRecipients.includes(
    request.action.recipient
  );
  return {
    id: "recipient-matches-policy",
    status: matched ? "PASS" : "FAIL",
    evidence: matched
      ? "recipient matches an approved policy entry"
      : `recipient ${request.action.recipient} is not an approved policy entry`,
  };
}

function checkRecipientNotPoisonDerived(
  request: ConsultRequest,
  _context: ConditionContext
): ConditionResult {
  const poisoned = POISONED_RECIPIENTS.has(request.action.recipient);
  return {
    id: "recipient-not-poison-derived",
    status: poisoned ? "FAIL" : "PASS",
    evidence: poisoned
      ? `recipient ${request.action.recipient} was first seen through a poison transfer`
      : `recipient ${request.action.recipient} has no recorded poison transfer`,
  };
}

function checkAssetIsCanonical(
  request: ConsultRequest,
  _context: ConditionContext
): ConditionResult {
  const canonical =
    CANONICAL_ASSETS[request.action.chainId]?.[request.action.asset.symbol];
  if (canonical === undefined) {
    return {
      id: "asset-is-canonical",
      status: "UNVERIFIED",
      evidence: `no canonical registry entry for ${request.action.chainId}:${request.action.asset.symbol}`,
    };
  }
  const matches = canonical === request.action.asset.contractAddress;
  return {
    id: "asset-is-canonical",
    status: matches ? "PASS" : "FAIL",
    evidence: matches
      ? "asset contract matches the canonical entry"
      : `asset contract ${request.action.asset.contractAddress} does not match the canonical entry ${canonical}`,
  };
}

function checkAmountWithinCap(
  request: ConsultRequest,
  context: ConditionContext
): ConditionResult {
  const cap = context.policy.perActionCaps[request.action.type];
  if (cap === undefined) {
    return {
      id: "amount-within-cap",
      status: "UNVERIFIED",
      evidence: `no policy cap configured for action type "${request.action.type}"`,
    };
  }
  // bigint, never floating point: amounts can exceed Number.MAX_SAFE_INTEGER.
  const within = BigInt(request.action.amount) <= BigInt(cap);
  return {
    id: "amount-within-cap",
    status: within ? "PASS" : "FAIL",
    evidence: within
      ? `amount ${request.action.amount} is within the cap ${cap}`
      : `amount ${request.action.amount} exceeds the cap ${cap}`,
  };
}

function checkChainMatchesIntent(
  request: ConsultRequest,
  context: ConditionContext
): ConditionResult {
  const matches = request.action.chainId === context.policy.chainId;
  return {
    id: "chain-matches-intent",
    status: matches ? "PASS" : "FAIL",
    evidence: matches
      ? `chain ${request.action.chainId} matches the owner's named chain`
      : `chain ${request.action.chainId} does not match the owner's named chain ${context.policy.chainId}`,
  };
}

export const PAY_FLOOR: ConditionDefinition[] = [
  {
    id: "recipient-matches-policy",
    isFloor: true,
    check: checkRecipientMatchesPolicy,
  },
  {
    id: "recipient-not-poison-derived",
    isFloor: true,
    check: checkRecipientNotPoisonDerived,
  },
  { id: "asset-is-canonical", isFloor: true, check: checkAssetIsCanonical },
  { id: "amount-within-cap", isFloor: true, check: checkAmountWithinCap },
  {
    id: "chain-matches-intent",
    isFloor: true,
    check: checkChainMatchesIntent,
  },
];

export const PAY_CATALOG: Catalog = {
  pay: PAY_FLOOR,
};
