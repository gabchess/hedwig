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

export type Catalog = Readonly<Record<string, readonly ConditionDefinition[]>>;

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
  "0x0000000000000000000000000000000000bad001";

const POISONED_RECIPIENTS: readonly string[] = [POISON_FLAGGED_RECIPIENT];

// Evidence strings echo caller-supplied text; cap it so one hostile field
// cannot blow up a log or a report.
const EVIDENCE_ECHO_LIMIT = 120;
export function truncate(value: string): string {
  return value.length > EVIDENCE_ECHO_LIMIT
    ? `${value.slice(0, EVIDENCE_ECHO_LIMIT)}...`
    : value;
}
export function describe(value: unknown): string {
  return truncate(typeof value === "string" ? value : String(value));
}

const EVM_ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

function isEvmChain(chainId: unknown): boolean {
  return typeof chainId === "string" && chainId.startsWith("eip155:");
}

// An EVM address is its 20 raw bytes; hex-digit case only carries an
// optional checksum encoding, never part of the value. Two addresses that
// differ only in case are the same recipient, so the comparison folds case
// once both sides pass the shape check; a lookalike differs in its actual
// hex digits and still fails.
function sameEvmAddress(a: unknown, b: unknown): true | false | "invalid" {
  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
    !EVM_ADDRESS_SHAPE.test(a) ||
    !EVM_ADDRESS_SHAPE.test(b)
  ) {
    return "invalid";
  }
  return a.toLowerCase() === b.toLowerCase();
}

// Caller-influenced strings (a chain id, an action type, an asset symbol)
// must never be used as an object key directly: "constructor" or "name"
// resolve through the prototype chain instead of failing the lookup.
function ownLookup<T>(source: unknown, key: unknown): T | undefined {
  if (
    typeof key !== "string" ||
    source === null ||
    typeof source !== "object" ||
    !Object.hasOwn(source, key)
  ) {
    return undefined;
  }
  return (source as Record<string, T>)[key];
}

// Shared by both recipient checkers: neither can compare a value it cannot
// first place in a validated chain family and shape.
function recipientShapeError(
  id: string,
  recipient: unknown,
  chainId: unknown
): ConditionResult | undefined {
  if (!isEvmChain(chainId)) {
    return {
      id,
      status: "UNVERIFIED",
      evidence: `cannot validate a recipient address for chain family "${describe(
        chainId
      )}"`,
    };
  }
  if (typeof recipient !== "string" || !EVM_ADDRESS_SHAPE.test(recipient)) {
    return {
      id,
      status: "UNVERIFIED",
      evidence: `recipient "${describe(
        recipient
      )}" is not a well-formed EVM address`,
    };
  }
  return undefined;
}

function checkRecipientMatchesPolicy(
  request: ConsultRequest,
  context: ConditionContext
): ConditionResult {
  const id = "recipient-matches-policy";
  const { recipient, chainId } = request.action;
  const { approvedRecipients } = context.policy;

  if (
    !Array.isArray(approvedRecipients) ||
    approvedRecipients.some(
      (entry) => typeof entry !== "string" || entry.length === 0
    )
  ) {
    return {
      id,
      status: "UNVERIFIED",
      evidence:
        "policy approvedRecipients is not a well-formed list of non-empty strings",
    };
  }
  const shapeError = recipientShapeError(id, recipient, chainId);
  if (shapeError) return shapeError;

  const matched = approvedRecipients.some(
    (entry) => sameEvmAddress(recipient, entry) === true
  );
  return {
    id,
    status: matched ? "PASS" : "FAIL",
    evidence: matched
      ? "recipient matches an approved policy entry"
      : `recipient ${describe(recipient)} is not an approved policy entry`,
  };
}

function checkRecipientNotPoisonDerived(
  request: ConsultRequest,
  _context: ConditionContext
): ConditionResult {
  const id = "recipient-not-poison-derived";
  const { recipient, chainId } = request.action;

  const shapeError = recipientShapeError(id, recipient, chainId);
  if (shapeError) return shapeError;

  const poisoned = POISONED_RECIPIENTS.some(
    (entry) => sameEvmAddress(recipient, entry) === true
  );
  return {
    id,
    status: poisoned ? "FAIL" : "PASS",
    evidence: poisoned
      ? `recipient ${describe(
          recipient
        )} was first seen through a poison transfer`
      : `recipient ${describe(recipient)} has no recorded poison transfer`,
  };
}

function checkAssetIsCanonical(
  request: ConsultRequest,
  _context: ConditionContext
): ConditionResult {
  const id = "asset-is-canonical";
  const { chainId, asset } = request.action;
  const symbol = asset?.symbol;
  const contractAddress = asset?.contractAddress;

  const byChain = ownLookup<Record<string, string>>(CANONICAL_ASSETS, chainId);
  const canonical = ownLookup<string>(byChain, symbol);
  if (canonical === undefined) {
    return {
      id,
      status: "UNVERIFIED",
      evidence: `no canonical registry entry for ${describe(
        chainId
      )}:${describe(symbol)}`,
    };
  }

  const matches = sameEvmAddress(canonical, contractAddress);
  if (matches === "invalid") {
    return {
      id,
      status: "UNVERIFIED",
      evidence: `asset contract address "${describe(
        contractAddress
      )}" is not a well-formed EVM address`,
    };
  }
  return {
    id,
    status: matches ? "PASS" : "FAIL",
    evidence: matches
      ? "asset contract matches the canonical entry"
      : `asset contract ${describe(
          contractAddress
        )} does not match the canonical entry ${canonical}`,
  };
}

const AMOUNT_SHAPE = /^(0|[1-9]\d*)$/;

function checkAmountWithinCap(
  request: ConsultRequest,
  context: ConditionContext
): ConditionResult {
  const id = "amount-within-cap";
  const { amount, type } = request.action;
  const cap = ownLookup<string>(context.policy.perActionCaps, type);

  if (cap === undefined) {
    return {
      id,
      status: "UNVERIFIED",
      evidence: `no policy cap configured for action type "${describe(type)}"`,
    };
  }
  if (
    typeof amount !== "string" ||
    !AMOUNT_SHAPE.test(amount) ||
    typeof cap !== "string" ||
    !AMOUNT_SHAPE.test(cap)
  ) {
    return {
      id,
      status: "UNVERIFIED",
      evidence: `amount "${describe(amount)}" or cap "${describe(
        cap
      )}" is not a well-formed non-negative integer string`,
    };
  }
  if (amount === "0") {
    return {
      id,
      status: "FAIL",
      evidence: "a payment of amount 0 is never what the owner approved",
    };
  }

  // bigint, never floating point: amounts can exceed Number.MAX_SAFE_INTEGER.
  const within = BigInt(amount) <= BigInt(cap);
  return {
    id,
    status: within ? "PASS" : "FAIL",
    evidence: within
      ? `amount ${amount} is within the cap ${cap}`
      : `amount ${amount} exceeds the cap ${cap}`,
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
      ? `chain ${describe(
          request.action.chainId
        )} matches the owner's named chain`
      : `chain ${describe(
          request.action.chainId
        )} does not match the owner's named chain ${describe(
          context.policy.chainId
        )}`,
  };
}

// Freeze-before-recurse: an already-frozen node is skipped, so a circular
// reference (as structuredClone can legitimately produce) cannot loop.
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}

const PAY_FLOOR: ConditionDefinition[] = [
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

// Frozen at module load: a caller can never splice, push, or reassign its
// way into shrinking or emptying the mandatory Floor.
export const PAY_CATALOG: Catalog = deepFreeze({
  pay: PAY_FLOOR,
});
