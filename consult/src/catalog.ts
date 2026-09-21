import { EVIDENCE_ECHO_LIMIT } from "./constants";
import type { CheckerOutcome, EvidenceClass } from "./fold";

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
  // The contract the transaction calls. Optional so a caller on an older
  // wire shape is a missing-field UNVERIFIED, never a crash.
  target?: string;
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
) => CheckerOutcome;

// Every code a Condition's checker may return for each status, declared up
// front so the catalog lint can prove they exist, are unique, and are
// well-formed, and so runChecker can reject a code the checker never
// declared.
export interface ConditionCodes {
  readonly pass: string;
  readonly fail: readonly string[];
  readonly unverified: readonly string[];
}

export interface ConditionDefinition {
  id: string;
  isFloor: boolean;
  // Fixed catalog text, phrased so PASS is the good answer. Never built
  // from request text.
  question: string;
  // Repo-relative path to this Condition's practice write-up.
  reference: string;
  codes: ConditionCodes;
  // The authoritative code -> evidence-class table for this Condition: the
  // core looks the checker's returned code up here rather than trusting an
  // evidenceClass the checker itself might report, so a checker can never
  // inflate its own proof.
  codeEvidenceClass: Readonly<Record<string, EvidenceClass>>;
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
// first place in a validated chain family and shape. Each caller passes its
// own codes, since a code is never reused across two Conditions.
function recipientShapeError(
  recipient: unknown,
  chainId: unknown,
  codes: { chainUnsupported: string; shapeInvalid: string }
): { code: string; evidence: string } | undefined {
  if (!isEvmChain(chainId)) {
    return {
      code: codes.chainUnsupported,
      evidence: `cannot validate a recipient address for chain family "${describe(
        chainId
      )}"`,
    };
  }
  if (typeof recipient !== "string" || !EVM_ADDRESS_SHAPE.test(recipient)) {
    return {
      code: codes.shapeInvalid,
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
): CheckerOutcome {
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
      code: "APPROVED_RECIPIENTS_INVALID",
      evidenceClass: "not-verifiable",
      evidence:
        "policy approvedRecipients is not a well-formed list of non-empty strings",
    };
  }
  const shapeError = recipientShapeError(recipient, chainId, {
    chainUnsupported: "RECIPIENT_CHAIN_UNSUPPORTED",
    shapeInvalid: "RECIPIENT_SHAPE_INVALID",
  });
  if (shapeError) {
    return {
      id,
      status: "UNVERIFIED",
      evidenceClass: "not-verifiable",
      ...shapeError,
    };
  }

  const matched = approvedRecipients.some(
    (entry) => sameEvmAddress(recipient, entry) === true
  );
  return {
    id,
    status: matched ? "PASS" : "FAIL",
    code: matched ? "RECIPIENT_MATCHES_POLICY" : "RECIPIENT_NOT_IN_POLICY",
    evidenceClass: "owner-policy",
    evidence: matched
      ? "recipient matches an approved policy entry"
      : `recipient ${describe(recipient)} is not an approved policy entry`,
  };
}

function checkRecipientNotPoisonDerived(
  request: ConsultRequest,
  _context: ConditionContext
): CheckerOutcome {
  const id = "recipient-not-poison-derived";
  const { recipient, chainId } = request.action;

  const shapeError = recipientShapeError(recipient, chainId, {
    chainUnsupported: "POISON_CHECK_CHAIN_UNSUPPORTED",
    shapeInvalid: "POISON_CHECK_SHAPE_INVALID",
  });
  if (shapeError) {
    return {
      id,
      status: "UNVERIFIED",
      evidenceClass: "not-verifiable",
      ...shapeError,
    };
  }

  const poisoned = POISONED_RECIPIENTS.some(
    (entry) => sameEvmAddress(recipient, entry) === true
  );
  return {
    id,
    status: poisoned ? "FAIL" : "PASS",
    code: poisoned
      ? "RECIPIENT_POISON_DERIVED"
      : "RECIPIENT_NOT_POISON_DERIVED",
    evidenceClass: "static-registry",
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
): CheckerOutcome {
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
      code: "ASSET_REGISTRY_ENTRY_MISSING",
      evidenceClass: "not-verifiable",
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
      code: "ASSET_ADDRESS_MALFORMED",
      evidenceClass: "not-verifiable",
      evidence: `asset contract address "${describe(
        contractAddress
      )}" is not a well-formed EVM address`,
    };
  }
  return {
    id,
    status: matches ? "PASS" : "FAIL",
    code: matches ? "ASSET_IS_CANONICAL" : "ASSET_NOT_CANONICAL",
    evidenceClass: "static-registry",
    evidence: matches
      ? "asset contract matches the canonical entry"
      : `asset contract ${describe(
          contractAddress
        )} does not match the canonical entry ${canonical}`,
  };
}

// The contract the transaction calls must be the canonical asset contract
// for the request's own symbol and chain: a legitimate payment never routes
// through any other contract.
function checkTargetIsCanonical(
  request: ConsultRequest,
  _context: ConditionContext
): CheckerOutcome {
  const id = "target-is-canonical";
  const { chainId, asset, target } = request.action;
  const symbol = asset?.symbol;

  if (!isEvmChain(chainId)) {
    return {
      id,
      status: "UNVERIFIED",
      code: "TARGET_CHAIN_UNSUPPORTED",
      evidenceClass: "not-verifiable",
      evidence: `cannot validate a target contract for chain family "${describe(
        chainId
      )}"`,
    };
  }
  if (typeof target !== "string" || !EVM_ADDRESS_SHAPE.test(target)) {
    return {
      id,
      status: "UNVERIFIED",
      code: "TARGET_SHAPE_INVALID",
      evidenceClass: "not-verifiable",
      evidence: `target "${describe(target)}" is not a well-formed EVM address`,
    };
  }

  const byChain = ownLookup<Record<string, string>>(CANONICAL_ASSETS, chainId);
  const canonical = ownLookup<string>(byChain, symbol);
  if (canonical === undefined) {
    return {
      id,
      status: "UNVERIFIED",
      code: "TARGET_REGISTRY_ENTRY_MISSING",
      evidenceClass: "not-verifiable",
      evidence: `no canonical registry entry for ${describe(
        chainId
      )}:${describe(symbol)}`,
    };
  }

  // Both sides are already known well-formed, so this never answers
  // "invalid": it is a clean value comparison.
  const matches = sameEvmAddress(canonical, target) === true;
  return {
    id,
    status: matches ? "PASS" : "FAIL",
    code: matches ? "TARGET_IS_CANONICAL" : "TARGET_NOT_CANONICAL",
    evidenceClass: "static-registry",
    evidence: matches
      ? "target contract matches the canonical entry"
      : `target contract ${describe(
          target
        )} does not match the canonical entry ${canonical}`,
  };
}

// 78 digits covers uint256's maximum value; anything longer cannot be a real
// amount, and rejecting it here means BigInt() never has to parse it.
const AMOUNT_SHAPE = /^(0|[1-9]\d{0,77})$/;

function checkAmountWithinCap(
  request: ConsultRequest,
  context: ConditionContext
): CheckerOutcome {
  const id = "amount-within-cap";
  const { amount, type } = request.action;
  const cap = ownLookup<string>(context.policy.perActionCaps, type);

  if (cap === undefined) {
    return {
      id,
      status: "UNVERIFIED",
      code: "CAP_MISSING",
      evidenceClass: "not-verifiable",
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
      code: "AMOUNT_MALFORMED",
      evidenceClass: "not-verifiable",
      evidence: `amount "${describe(amount)}" or cap "${describe(
        cap
      )}" is not a well-formed non-negative integer string`,
    };
  }
  if (amount === "0") {
    return {
      id,
      status: "FAIL",
      code: "AMOUNT_ZERO",
      evidenceClass: "owner-policy",
      evidence: "a payment of amount 0 is never what the owner approved",
    };
  }

  // bigint, never floating point: amounts can exceed Number.MAX_SAFE_INTEGER.
  const within = BigInt(amount) <= BigInt(cap);
  return {
    id,
    status: within ? "PASS" : "FAIL",
    code: within ? "AMOUNT_WITHIN_CAP" : "AMOUNT_EXCEEDS_CAP",
    evidenceClass: "owner-policy",
    evidence: within
      ? `amount ${describe(amount)} is within the cap ${describe(cap)}`
      : `amount ${describe(amount)} exceeds the cap ${describe(cap)}`,
  };
}

// eip155:1, solana:mainnet: a CAIP-2 id has a lowercase namespace of 3-8
// characters, a colon, then a 1-32 character reference.
const CAIP2_SHAPE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

function isCaip2(value: unknown): value is string {
  return typeof value === "string" && CAIP2_SHAPE.test(value);
}

function checkChainMatchesIntent(
  request: ConsultRequest,
  context: ConditionContext
): CheckerOutcome {
  const id = "chain-matches-intent";
  const { chainId } = request.action;
  const ownerChainId = context.policy.chainId;

  // Equality between two absent values is not equality of anything real:
  // both sides must be a well-formed chain id before comparing them means
  // the request and the owner's intent actually agree.
  if (!isCaip2(chainId) || !isCaip2(ownerChainId)) {
    return {
      id,
      status: "UNVERIFIED",
      code: "CHAIN_ID_MALFORMED",
      evidenceClass: "not-verifiable",
      evidence: `chain "${describe(
        chainId
      )}" or the owner's named chain "${describe(
        ownerChainId
      )}" is not a well-formed CAIP-2 id`,
    };
  }

  const matches = chainId === ownerChainId;
  return {
    id,
    status: matches ? "PASS" : "FAIL",
    code: matches ? "CHAIN_MATCHES_INTENT" : "CHAIN_MISMATCH",
    evidenceClass: "owner-policy",
    evidence: matches
      ? `chain ${describe(chainId)} matches the owner's named chain`
      : `chain ${describe(
          chainId
        )} does not match the owner's named chain ${describe(ownerChainId)}`,
  };
}

// Freeze-before-recurse skips a node already frozen, so a circular reference
// cannot loop forever.
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}

const REFERENCE_ROOT = "consult/references/pay";

const PAY_FLOOR: ConditionDefinition[] = [
  {
    id: "recipient-matches-policy",
    isFloor: true,
    question: "Does the recipient match an entry the owner approved?",
    reference: `${REFERENCE_ROOT}/recipient-matches-policy.md`,
    codes: {
      pass: "RECIPIENT_MATCHES_POLICY",
      fail: ["RECIPIENT_NOT_IN_POLICY"],
      unverified: [
        "RECIPIENT_SHAPE_INVALID",
        "RECIPIENT_CHAIN_UNSUPPORTED",
        "APPROVED_RECIPIENTS_INVALID",
      ],
    },
    codeEvidenceClass: {
      RECIPIENT_MATCHES_POLICY: "owner-policy",
      RECIPIENT_NOT_IN_POLICY: "owner-policy",
      RECIPIENT_SHAPE_INVALID: "not-verifiable",
      RECIPIENT_CHAIN_UNSUPPORTED: "not-verifiable",
      APPROVED_RECIPIENTS_INVALID: "not-verifiable",
    },
    check: checkRecipientMatchesPolicy,
  },
  {
    id: "recipient-not-poison-derived",
    isFloor: true,
    question: "Is the recipient free of any recorded poison transfer?",
    reference: `${REFERENCE_ROOT}/recipient-not-poison-derived.md`,
    codes: {
      pass: "RECIPIENT_NOT_POISON_DERIVED",
      fail: ["RECIPIENT_POISON_DERIVED"],
      unverified: [
        "POISON_CHECK_SHAPE_INVALID",
        "POISON_CHECK_CHAIN_UNSUPPORTED",
      ],
    },
    codeEvidenceClass: {
      RECIPIENT_NOT_POISON_DERIVED: "static-registry",
      RECIPIENT_POISON_DERIVED: "static-registry",
      POISON_CHECK_SHAPE_INVALID: "not-verifiable",
      POISON_CHECK_CHAIN_UNSUPPORTED: "not-verifiable",
    },
    check: checkRecipientNotPoisonDerived,
  },
  {
    id: "asset-is-canonical",
    isFloor: true,
    question: "Does the asset contract match the canonical entry?",
    reference: `${REFERENCE_ROOT}/asset-is-canonical.md`,
    codes: {
      pass: "ASSET_IS_CANONICAL",
      fail: ["ASSET_NOT_CANONICAL"],
      unverified: ["ASSET_REGISTRY_ENTRY_MISSING", "ASSET_ADDRESS_MALFORMED"],
    },
    codeEvidenceClass: {
      ASSET_IS_CANONICAL: "static-registry",
      ASSET_NOT_CANONICAL: "static-registry",
      ASSET_REGISTRY_ENTRY_MISSING: "not-verifiable",
      ASSET_ADDRESS_MALFORMED: "not-verifiable",
    },
    check: checkAssetIsCanonical,
  },
  {
    id: "amount-within-cap",
    isFloor: true,
    question:
      "Is the amount above zero and within the owner's cap for this action?",
    reference: `${REFERENCE_ROOT}/amount-within-cap.md`,
    codes: {
      pass: "AMOUNT_WITHIN_CAP",
      fail: ["AMOUNT_EXCEEDS_CAP", "AMOUNT_ZERO"],
      unverified: ["CAP_MISSING", "AMOUNT_MALFORMED"],
    },
    codeEvidenceClass: {
      AMOUNT_WITHIN_CAP: "owner-policy",
      AMOUNT_EXCEEDS_CAP: "owner-policy",
      AMOUNT_ZERO: "owner-policy",
      CAP_MISSING: "not-verifiable",
      AMOUNT_MALFORMED: "not-verifiable",
    },
    check: checkAmountWithinCap,
  },
  {
    id: "chain-matches-intent",
    isFloor: true,
    question: "Does the request's chain match the owner's named chain?",
    reference: `${REFERENCE_ROOT}/chain-matches-intent.md`,
    codes: {
      pass: "CHAIN_MATCHES_INTENT",
      fail: ["CHAIN_MISMATCH"],
      unverified: ["CHAIN_ID_MALFORMED"],
    },
    codeEvidenceClass: {
      CHAIN_MATCHES_INTENT: "owner-policy",
      CHAIN_MISMATCH: "owner-policy",
      CHAIN_ID_MALFORMED: "not-verifiable",
    },
    check: checkChainMatchesIntent,
  },
  {
    id: "target-is-canonical",
    isFloor: true,
    question: "Does the transaction call the canonical asset contract?",
    reference: `${REFERENCE_ROOT}/target-is-canonical.md`,
    codes: {
      pass: "TARGET_IS_CANONICAL",
      fail: ["TARGET_NOT_CANONICAL"],
      unverified: [
        "TARGET_SHAPE_INVALID",
        "TARGET_CHAIN_UNSUPPORTED",
        "TARGET_REGISTRY_ENTRY_MISSING",
      ],
    },
    codeEvidenceClass: {
      TARGET_IS_CANONICAL: "static-registry",
      TARGET_NOT_CANONICAL: "static-registry",
      TARGET_SHAPE_INVALID: "not-verifiable",
      TARGET_CHAIN_UNSUPPORTED: "not-verifiable",
      TARGET_REGISTRY_ENTRY_MISSING: "not-verifiable",
    },
    check: checkTargetIsCanonical,
  },
];

// Frozen at module load: a caller can never splice, push, or reassign its
// way into shrinking or emptying the mandatory Floor.
export const PAY_CATALOG: Catalog = deepFreeze({
  pay: PAY_FLOOR,
});

const CODE_SHAPE = /^[A-Z][A-Z0-9_]+$/;

// The codes the core puts on its own rows. A Condition that declared one
// of these would give it a second meaning.
const CORE_CODES: readonly string[] = [
  "ACTION_TYPE_UNKNOWN",
  "CHECKER_THREW",
  "CONDITION_UNKNOWN",
  "FLOOR_MISSING",
  "INPUT_SHAPE_INVALID",
  "INPUT_TOO_LARGE",
  "RESULT_MALFORMED",
];

// Returns the first defect found, or undefined for a sound catalog. A
// caller who can choose the catalog controls the verdict, so a catalog
// missing its mandatory Floor, or carrying a duplicate or empty id, a
// malformed code, or a code with no evidence class, is a programming error,
// not a request to answer.
export function validateCatalog(catalog: unknown): string | undefined {
  if (catalog === null || typeof catalog !== "object") {
    return "catalog must be an object";
  }
  const seenCodes = new Set<string>(CORE_CODES);
  for (const [actionType, conditions] of Object.entries(
    catalog as Record<string, unknown>
  )) {
    if (!Array.isArray(conditions)) {
      return `catalog action type "${actionType}" is not an array of Conditions`;
    }
    let hasFloor = false;
    const seenIds = new Set<string>();
    for (const condition of conditions) {
      if (condition === null || typeof condition !== "object") {
        return `catalog action type "${actionType}" has a Condition that is not an object`;
      }
      const {
        id,
        isFloor,
        check,
        question,
        reference,
        codes,
        codeEvidenceClass,
      } = condition as Record<string, unknown>;
      if (typeof id !== "string" || id.length === 0) {
        return `catalog action type "${actionType}" has a Condition with an empty or non-string id`;
      }
      if (seenIds.has(id)) {
        return `catalog action type "${actionType}" has a duplicate Condition id "${id}"`;
      }
      seenIds.add(id);
      if (typeof check !== "function") {
        return `catalog action type "${actionType}" Condition "${id}" has a non-function check`;
      }
      if (typeof question !== "string" || question.trim().length === 0) {
        return `catalog Condition "${id}" has an empty or non-string question`;
      }
      if (typeof reference !== "string" || reference.trim().length === 0) {
        return `catalog Condition "${id}" has an empty or non-string reference`;
      }
      const defect = validateConditionCodes(
        id,
        codes,
        codeEvidenceClass,
        seenCodes
      );
      if (defect !== undefined) {
        return defect;
      }
      if (isFloor === true) {
        hasFloor = true;
      }
    }
    if (!hasFloor) {
      return `catalog action type "${actionType}" has no mandatory Floor Condition`;
    }
  }
  return undefined;
}

function validateConditionCodes(
  conditionId: string,
  codes: unknown,
  codeEvidenceClass: unknown,
  seenCodes: Set<string>
): string | undefined {
  if (codes === null || typeof codes !== "object") {
    return `catalog Condition "${conditionId}" has no codes declared`;
  }
  const { pass, fail, unverified } = codes as Record<string, unknown>;
  if (typeof pass !== "string") {
    return `catalog Condition "${conditionId}" must declare exactly one PASS code`;
  }
  if (!Array.isArray(fail) || fail.length === 0) {
    return `catalog Condition "${conditionId}" must declare at least one FAIL code`;
  }
  if (!Array.isArray(unverified) || unverified.length === 0) {
    return `catalog Condition "${conditionId}" must declare at least one UNVERIFIED code`;
  }
  if (codeEvidenceClass === null || typeof codeEvidenceClass !== "object") {
    return `catalog Condition "${conditionId}" has no codeEvidenceClass table`;
  }
  const classTable = codeEvidenceClass as Record<string, unknown>;
  const allCodes = [pass, ...fail, ...unverified];
  for (const code of allCodes) {
    if (typeof code !== "string" || !CODE_SHAPE.test(code)) {
      return `catalog Condition "${conditionId}" has a malformed code "${String(
        code
      )}"`;
    }
    if (seenCodes.has(code)) {
      return `catalog Condition "${conditionId}" reuses code "${code}", which the core or another Condition already declares`;
    }
    seenCodes.add(code);
    const evidenceClass = classTable[code];
    if (
      evidenceClass !== "onchain-read" &&
      evidenceClass !== "owner-policy" &&
      evidenceClass !== "static-registry" &&
      evidenceClass !== "not-verifiable"
    ) {
      return `catalog Condition "${conditionId}" has no valid evidence class for code "${code}"`;
    }
    if (code === pass && evidenceClass === "not-verifiable") {
      return `catalog Condition "${conditionId}" declares its PASS code "${code}" as not-verifiable evidence`;
    }
  }
  return undefined;
}

export function assertValidCatalog(catalog: Catalog): void {
  const defect = validateCatalog(catalog);
  if (defect !== undefined) {
    throw new Error(defect);
  }
}

// A programming error in the trusted, built-in catalog throws here, at
// import time, never at request time.
assertValidCatalog(PAY_CATALOG);
