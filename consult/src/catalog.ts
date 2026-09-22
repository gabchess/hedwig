import {
  EVIDENCE_CLASS_WEIGHTS,
  EVIDENCE_ECHO_LIMIT,
  MAX_ROLE_FACT_AGE_SECONDS,
} from "./constants";
import type { CheckerOutcome, EvidenceClass } from "./fold";

export type SolanaCluster = "devnet" | "testnet" | "mainnet-beta";

// The owner's Solana role requirement, stated by the owner and never by the
// request. `member` is optional; the Floor Condition checks its shape and
// never compares it.
export interface RequiredRolePolicy {
  mode: "required";
  cluster: SolanaCluster;
  programId: string;
  role: string;
  holder: string;
  member?: string;
  maxAgeSeconds: number;
}

export type RolePolicy = { mode: "not-required" } | RequiredRolePolicy;

export interface Policy {
  permits: boolean;
  chainId: string;
  approvedRecipients: string[];
  perActionCaps: Record<string, string>;
  // swap-only policy fields. Optional so a pay-only policy never has to
  // declare them; a swap Condition that needs one and finds it missing
  // answers UNVERIFIED rather than guessing a default.
  maxSlippageBps?: number;
  maxDeadlineSeconds?: number;
  ownerAddresses?: string[];
  // Shared by pay and swap: whether the agent must currently hold a named
  // Solana role. Optional so an untouched fixture predates this field the
  // same way a swap-only field predates a pay-only policy; a role
  // Condition that finds it missing answers UNVERIFIED rather than
  // guessing a default.
  role?: RolePolicy;
}

// The shape of a Solana role fact `role-requirement-met` reads, and the
// shape of `context.facts` this repository ever produces. Exported for a
// caller's own typing; consult() itself still treats `context.facts` as
// unread, untrusted `unknown` data (see ConditionContext below): only a
// Condition's own checker narrows it, and only after proving each field's
// shape for itself.
export interface RoleFactSubject {
  cluster: string;
  programId: string;
  role: string;
  holder: string;
}

export interface RoleFact {
  subject: RoleFactSubject;
  valid: boolean;
  reason: "ok" | "RoleDisabled" | "MembershipExpired" | "MemberMissing";
  provenance: {
    source: string;
    slot: number;
    commitment: "confirmed" | "finalized";
    observedAt: number;
  };
}

export interface Facts {
  now?: number;
  solanaRole?: RoleFact;
}

// One flat shape covering every action type this catalog knows: pay's
// fields and swap's fields are each optional, since a request for one
// action type never carries the other's fields. Every checker reads its
// own fields defensively (typeof checks), so an absent or wrong-shaped
// field never crashes a check, only earns it an UNVERIFIED or a FAIL.
export interface ConsultAction {
  type: string;
  chainId: string;
  // The contract the transaction calls: the asset contract for pay, the
  // router for swap. Optional so a caller on an older wire shape is a
  // missing-field UNVERIFIED, never a crash.
  target?: string;

  // Shared by pay and swap.
  recipient?: string;

  // pay-only fields.
  asset?: { symbol: string; contractAddress: string };
  amount?: string;

  // swap-only fields.
  tokenIn?: { symbol: string; contractAddress: string };
  tokenOut?: { symbol: string; contractAddress: string };
  amountIn?: string;
  quotedOut?: string;
  minOut?: string;
  slippageBps?: number;
  deadline?: number;
  approvalAmount?: string;
}

export interface ConsultRequest {
  action: ConsultAction;
  conditions?: string[];
}

export interface ConditionContext {
  policy: Policy;
  // Time as data, not a clock the core or a Condition ever reads directly.
  // Whatever shape survived cloning: a Condition that needs `now` narrows
  // it itself and answers UNVERIFIED when it cannot.
  facts: unknown;
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
  // Almost every Condition earns PASS one way; role-requirement-met earns
  // it two distinct ways (no role required, or a role held), each with its
  // own evidence class, so this accepts either a single code or a short
  // list of them. `passCodesOf` below is the one place that normalises it.
  readonly pass: string | readonly string[];
  readonly fail: readonly string[];
  readonly unverified: readonly string[];
}

// The catalog's own PASS codes for a Condition, always as a list: a single
// code becomes a one-element list, so every caller (the core's
// codeDeclaredForStatus, the catalog's own validation, consultWith's
// rebinding, and the catalog lint) reads this one function instead of
// re-deriving the string-or-array split for itself.
export function passCodesOf(
  codes: Pick<ConditionCodes, "pass">
): readonly string[] {
  return Array.isArray(codes.pass) ? codes.pass : [codes.pass as string];
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
// Verified against https://weth.io (the project's own list of canonical
// WETH contract addresses per chain) on 2026-09-21. Only present so a swap
// fixture can name two distinct canonical tokens on the same chain; pay's
// own Floor never depended on a second entry existing.
export const CANONICAL_WETH_SYMBOL = "WETH";
export const CANONICAL_WETH_ADDRESS =
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// Base (eip155:8453). USDC verified against Circle's own contract address
// list (https://developers.circle.com/stablecoins/usdc-contract-addresses)
// and WETH against Base's own contract list
// (https://docs.base.org/base-chain/network-information/base-contracts),
// both on 2026-09-22; each contract's symbol() was also read from the chain.
export const BASE_CHAIN_ID = "eip155:8453";
export const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_WETH_ADDRESS = "0x4200000000000000000000000000000000000006";

const CANONICAL_ASSETS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = Object.freeze({
  [CANONICAL_CHAIN_ID]: Object.freeze({
    [CANONICAL_ASSET_SYMBOL]: CANONICAL_ASSET_ADDRESS,
    [CANONICAL_WETH_SYMBOL]: CANONICAL_WETH_ADDRESS,
  }),
  [BASE_CHAIN_ID]: Object.freeze({
    [CANONICAL_ASSET_SYMBOL]: BASE_USDC_ADDRESS,
    [CANONICAL_WETH_SYMBOL]: BASE_WETH_ADDRESS,
  }),
});

// Uniswap's own Universal Router deployment addresses, verified 2026-09-21
// against https://github.com/Uniswap/universal-router/blob/main/deploy-addresses/
// (the canonical source docs.uniswap.org/contracts/v3/reference/deployments
// itself names as the up-to-date list), field UniversalRouterV2_1_2 for
// each chain. Only chains verified this way are ever in this table; an
// unlisted chain answers UNVERIFIED rather than guessing.
export const CANONICAL_ROUTERS: Readonly<Record<string, string>> =
  Object.freeze({
    "eip155:1": "0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85",
    "eip155:8453": "0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40",
  });

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

// The current time as data: consult() never calls a clock itself, so a
// Condition that needs "now" reads it from context.facts, which the core
// only clones and freezes. `facts` may be missing, malformed, or not an
// object at all; this reads a well-formed field out of it or answers
// undefined, never throwing either way.
function readFactNow(facts: unknown): number | undefined {
  if (facts === null || typeof facts !== "object" || Array.isArray(facts)) {
    return undefined;
  }
  const now = (facts as Record<string, unknown>).now;
  return typeof now === "number" && Number.isSafeInteger(now) && now > 0
    ? now
    : undefined;
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

interface AmountWithinCapCodes {
  readonly pass: string;
  readonly exceeds: string;
  readonly zero: string;
  readonly capMissing: string;
  readonly malformed: string;
}

// Shared by pay's `amount` and swap's `amountIn`: the rule ("above zero,
// within the owner's per-action cap") is one rule, so it is one function.
// Each caller supplies its own id, the field to read, and its own codes,
// since a code is never reused across two Conditions.
function makeAmountWithinCapChecker(
  id: string,
  amountField: "amount" | "amountIn",
  codes: AmountWithinCapCodes
): ConditionChecker {
  return function checkAmountWithinCap(
    request: ConsultRequest,
    context: ConditionContext
  ): CheckerOutcome {
    const action = request.action as unknown as Record<string, unknown>;
    const amount = action[amountField];
    const type = request.action.type;
    const cap = ownLookup<string>(context.policy.perActionCaps, type);

    if (cap === undefined) {
      return {
        id,
        status: "UNVERIFIED",
        code: codes.capMissing,
        evidenceClass: "not-verifiable",
        evidence: `no policy cap configured for action type "${describe(
          type
        )}"`,
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
        code: codes.malformed,
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
        code: codes.zero,
        evidenceClass: "owner-policy",
        evidence: "an amount of 0 is never what the owner approved",
      };
    }

    // bigint, never floating point: amounts can exceed Number.MAX_SAFE_INTEGER.
    const within = BigInt(amount) <= BigInt(cap);
    return {
      id,
      status: within ? "PASS" : "FAIL",
      code: within ? codes.pass : codes.exceeds,
      evidenceClass: "owner-policy",
      evidence: within
        ? `amount ${describe(amount)} is within the cap ${describe(cap)}`
        : `amount ${describe(amount)} exceeds the cap ${describe(cap)}`,
    };
  };
}

// eip155:1, solana:mainnet: a CAIP-2 id has a lowercase namespace of 3-8
// characters, a colon, then a 1-32 character reference.
const CAIP2_SHAPE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

function isCaip2(value: unknown): value is string {
  return typeof value === "string" && CAIP2_SHAPE.test(value);
}

interface ChainMatchesIntentCodes {
  readonly pass: string;
  readonly mismatch: string;
  readonly malformed: string;
}

// Shared by pay and swap: both read the same two fields
// (request.action.chainId and the owner's policy.chainId), so this is one
// rule with two code tables, not two rules.
function makeChainMatchesIntentChecker(
  id: string,
  codes: ChainMatchesIntentCodes
): ConditionChecker {
  return function checkChainMatchesIntent(
    request: ConsultRequest,
    context: ConditionContext
  ): CheckerOutcome {
    const { chainId } = request.action;
    const ownerChainId = context.policy.chainId;

    // Equality between two absent values is not equality of anything real:
    // both sides must be a well-formed chain id before comparing them means
    // the request and the owner's intent actually agree.
    if (!isCaip2(chainId) || !isCaip2(ownerChainId)) {
      return {
        id,
        status: "UNVERIFIED",
        code: codes.malformed,
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
      code: matches ? codes.pass : codes.mismatch,
      evidenceClass: "owner-policy",
      evidence: matches
        ? `chain ${describe(chainId)} matches the owner's named chain`
        : `chain ${describe(
            chainId
          )} does not match the owner's named chain ${describe(ownerChainId)}`,
    };
  };
}

// Base58, the Bitcoin alphabet: digits and letters minus the four an eye can
// mistake for one another (0, O, I, l). A Solana pubkey, base58-encoded, is
// 32 to 44 characters.
const BASE58_ID_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isBase58RoleId(value: unknown): value is string {
  return typeof value === "string" && BASE58_ID_SHAPE.test(value);
}

const SOLANA_CLUSTERS: readonly string[] = [
  "devnet",
  "testnet",
  "mainnet-beta",
];

function isSolanaCluster(value: unknown): boolean {
  return typeof value === "string" && SOLANA_CLUSTERS.includes(value);
}

const ROLE_FACT_REASONS: readonly string[] = [
  "ok",
  "RoleDisabled",
  "MembershipExpired",
  "MemberMissing",
];

interface RoleRequirementMetCodes {
  readonly notRequired: string;
  readonly held: string;
  readonly disabled: string;
  readonly membershipExpired: string;
  readonly memberMissing: string;
  readonly policyMissing: string;
  readonly policyMalformed: string;
  readonly factMissing: string;
  readonly factMalformed: string;
  readonly subjectMismatch: string;
  readonly ageUnknown: string;
  readonly stale: string;
}

// Shared by pay and swap: the owner may require the agent to currently hold
// a named Solana role, proven by a `RoleFact` the caller of consult()
// supplies as data (never fetched here; this Condition makes no network or
// RPC call of its own). The request is never read: only the owner's policy
// and the supplied facts decide this row. Each caller supplies its own id
// and codes, since a code is never reused across two Conditions.
function makeRoleRequirementMetChecker(
  id: string,
  codes: RoleRequirementMetCodes
): ConditionChecker {
  return function checkRoleRequirementMet(
    _request: ConsultRequest,
    context: ConditionContext
  ): CheckerOutcome {
    const unverified = (code: string, evidence: string): CheckerOutcome => ({
      id,
      status: "UNVERIFIED",
      code,
      evidenceClass: "not-verifiable",
      evidence,
    });

    const role = (context.policy as unknown as { role?: unknown }).role;
    if (role === null || typeof role !== "object" || Array.isArray(role)) {
      return unverified(
        codes.policyMissing,
        "policy role requirement is missing or not an object"
      );
    }
    const mode = (role as Record<string, unknown>).mode;
    if (mode !== "required" && mode !== "not-required") {
      return unverified(
        codes.policyMissing,
        `policy role mode "${describe(
          mode
        )}" is neither "required" nor "not-required"`
      );
    }
    if (mode === "not-required") {
      return {
        id,
        status: "PASS",
        code: codes.notRequired,
        evidenceClass: "owner-policy",
        evidence: "owner policy requires no role",
      };
    }

    const required = role as Record<string, unknown>;
    const cluster = required.cluster;
    const programId = required.programId;
    const requiredRole = required.role;
    const holder = required.holder;
    const member = required.member;
    const maxAgeSeconds = required.maxAgeSeconds;

    if (
      !isSolanaCluster(cluster) ||
      !isBase58RoleId(programId) ||
      !isBase58RoleId(requiredRole) ||
      !isBase58RoleId(holder) ||
      (member !== undefined && !isBase58RoleId(member)) ||
      typeof maxAgeSeconds !== "number" ||
      !Number.isInteger(maxAgeSeconds) ||
      maxAgeSeconds < 1 ||
      maxAgeSeconds > MAX_ROLE_FACT_AGE_SECONDS
    ) {
      return unverified(
        codes.policyMalformed,
        "policy role requirement is not a well-formed required-role policy"
      );
    }

    const facts = context.facts;
    const fact =
      facts !== null && typeof facts === "object" && !Array.isArray(facts)
        ? (facts as Record<string, unknown>).solanaRole
        : undefined;
    if (fact === null || typeof fact !== "object" || Array.isArray(fact)) {
      return unverified(codes.factMissing, "no solanaRole fact was supplied");
    }

    const factRecord = fact as Record<string, unknown>;
    const subject = factRecord.subject;
    const subjectRecord =
      subject !== null && typeof subject === "object" && !Array.isArray(subject)
        ? (subject as Record<string, unknown>)
        : undefined;
    const factCluster = subjectRecord?.cluster;
    const factProgramId = subjectRecord?.programId;
    const factRole = subjectRecord?.role;
    const factHolder = subjectRecord?.holder;
    const valid = factRecord.valid;
    const reason = factRecord.reason;
    const provenance = factRecord.provenance;
    const provenanceRecord =
      provenance !== null &&
      typeof provenance === "object" &&
      !Array.isArray(provenance)
        ? (provenance as Record<string, unknown>)
        : undefined;
    const source = provenanceRecord?.source;
    const slot = provenanceRecord?.slot;
    const commitment = provenanceRecord?.commitment;
    const observedAt = provenanceRecord?.observedAt;

    if (
      subjectRecord === undefined ||
      typeof factCluster !== "string" ||
      typeof factProgramId !== "string" ||
      typeof factRole !== "string" ||
      typeof factHolder !== "string" ||
      typeof valid !== "boolean" ||
      typeof reason !== "string" ||
      !ROLE_FACT_REASONS.includes(reason) ||
      (valid === true && reason !== "ok") ||
      (valid === false && reason === "ok") ||
      provenanceRecord === undefined ||
      typeof source !== "string" ||
      source.length === 0 ||
      source.length > 200 ||
      typeof slot !== "number" ||
      !Number.isSafeInteger(slot) ||
      slot < 0 ||
      (commitment !== "confirmed" && commitment !== "finalized") ||
      typeof observedAt !== "number" ||
      !Number.isSafeInteger(observedAt) ||
      observedAt <= 0
    ) {
      return unverified(
        codes.factMalformed,
        "the solanaRole fact is not a well-formed role record"
      );
    }

    if (
      factCluster !== cluster ||
      factProgramId !== programId ||
      factRole !== requiredRole ||
      factHolder !== holder
    ) {
      return unverified(
        codes.subjectMismatch,
        `role fact names ${describe(factRole)} for holder ${describe(
          factHolder
        )}, not the policy's role ${describe(
          requiredRole
        )} for holder ${describe(holder)}`
      );
    }

    const now = readFactNow(context.facts);
    if (now === undefined) {
      return unverified(
        codes.ageUnknown,
        "the current time was not supplied to compare against the role fact's age"
      );
    }

    const age = now - observedAt;
    if (age < 0) {
      return unverified(
        codes.stale,
        `the role fact's observedAt is ${-age} seconds in the future`
      );
    }
    if (age > maxAgeSeconds) {
      return unverified(
        codes.stale,
        `the role fact is ${age} seconds old, past the owner's ${maxAgeSeconds}-second window`
      );
    }

    if (valid === false) {
      const failCode =
        reason === "RoleDisabled"
          ? codes.disabled
          : reason === "MembershipExpired"
          ? codes.membershipExpired
          : codes.memberMissing;
      return {
        id,
        status: "FAIL",
        code: failCode,
        evidenceClass: "onchain-read",
        evidence: `holder ${describe(holder)} does not hold role ${describe(
          requiredRole
        )}: ${reason}`,
      };
    }

    return {
      id,
      status: "PASS",
      code: codes.held,
      evidenceClass: "onchain-read",
      evidence: `holder ${describe(holder)} holds role ${describe(
        requiredRole
      )}`,
    };
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
    check: makeAmountWithinCapChecker("amount-within-cap", "amount", {
      pass: "AMOUNT_WITHIN_CAP",
      exceeds: "AMOUNT_EXCEEDS_CAP",
      zero: "AMOUNT_ZERO",
      capMissing: "CAP_MISSING",
      malformed: "AMOUNT_MALFORMED",
    }),
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
    check: makeChainMatchesIntentChecker("chain-matches-intent", {
      pass: "CHAIN_MATCHES_INTENT",
      mismatch: "CHAIN_MISMATCH",
      malformed: "CHAIN_ID_MALFORMED",
    }),
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
  {
    id: "role-requirement-met",
    isFloor: true,
    question: "Is the owner's role requirement met?",
    reference: `${REFERENCE_ROOT}/role-requirement-met.md`,
    codes: {
      pass: ["ROLE_NOT_REQUIRED", "ROLE_HELD"],
      fail: ["ROLE_DISABLED", "ROLE_MEMBERSHIP_EXPIRED", "ROLE_MEMBER_MISSING"],
      unverified: [
        "ROLE_POLICY_MISSING",
        "ROLE_POLICY_MALFORMED",
        "ROLE_FACT_MISSING",
        "ROLE_FACT_MALFORMED",
        "ROLE_FACT_SUBJECT_MISMATCH",
        "ROLE_FACT_AGE_UNKNOWN",
        "ROLE_FACT_STALE",
      ],
    },
    codeEvidenceClass: {
      ROLE_NOT_REQUIRED: "owner-policy",
      ROLE_HELD: "onchain-read",
      ROLE_DISABLED: "onchain-read",
      ROLE_MEMBERSHIP_EXPIRED: "onchain-read",
      ROLE_MEMBER_MISSING: "onchain-read",
      ROLE_POLICY_MISSING: "not-verifiable",
      ROLE_POLICY_MALFORMED: "not-verifiable",
      ROLE_FACT_MISSING: "not-verifiable",
      ROLE_FACT_MALFORMED: "not-verifiable",
      ROLE_FACT_SUBJECT_MISMATCH: "not-verifiable",
      ROLE_FACT_AGE_UNKNOWN: "not-verifiable",
      ROLE_FACT_STALE: "not-verifiable",
    },
    check: makeRoleRequirementMetChecker("role-requirement-met", {
      notRequired: "ROLE_NOT_REQUIRED",
      held: "ROLE_HELD",
      disabled: "ROLE_DISABLED",
      membershipExpired: "ROLE_MEMBERSHIP_EXPIRED",
      memberMissing: "ROLE_MEMBER_MISSING",
      policyMissing: "ROLE_POLICY_MISSING",
      policyMalformed: "ROLE_POLICY_MALFORMED",
      factMissing: "ROLE_FACT_MISSING",
      factMalformed: "ROLE_FACT_MALFORMED",
      subjectMismatch: "ROLE_FACT_SUBJECT_MISMATCH",
      ageUnknown: "ROLE_FACT_AGE_UNKNOWN",
      stale: "ROLE_FACT_STALE",
    }),
  },
];

// Frozen at module load: a caller can never splice, push, or reassign its
// way into shrinking or emptying the mandatory Floor.
export const PAY_CATALOG: Catalog = deepFreeze({
  pay: PAY_FLOOR,
});

// --- swap ---------------------------------------------------------------

const SWAP_REFERENCE_ROOT = "consult/references/swap";

// The router a swap calls must be a canonical Universal Router deployment
// for the request's own chain.
function checkSwapTargetIsCanonical(
  request: ConsultRequest,
  _context: ConditionContext
): CheckerOutcome {
  const id = "target-is-canonical";
  const { chainId, target } = request.action;

  if (!isEvmChain(chainId)) {
    return {
      id,
      status: "UNVERIFIED",
      code: "SWAP_TARGET_CHAIN_UNSUPPORTED",
      evidenceClass: "not-verifiable",
      evidence: `cannot validate a router contract for chain family "${describe(
        chainId
      )}"`,
    };
  }
  if (typeof target !== "string" || !EVM_ADDRESS_SHAPE.test(target)) {
    return {
      id,
      status: "UNVERIFIED",
      code: "SWAP_TARGET_SHAPE_INVALID",
      evidenceClass: "not-verifiable",
      evidence: `target "${describe(target)}" is not a well-formed EVM address`,
    };
  }

  const canonical = ownLookup<string>(CANONICAL_ROUTERS, chainId);
  if (canonical === undefined) {
    return {
      id,
      status: "UNVERIFIED",
      code: "SWAP_TARGET_ROUTER_UNKNOWN",
      evidenceClass: "not-verifiable",
      evidence: `no canonical router entry for chain ${describe(chainId)}`,
    };
  }

  const matches = sameEvmAddress(canonical, target) === true;
  return {
    id,
    status: matches ? "PASS" : "FAIL",
    code: matches ? "SWAP_TARGET_IS_CANONICAL" : "SWAP_TARGET_NOT_CANONICAL",
    evidenceClass: "static-registry",
    evidence: matches
      ? "target contract matches the canonical router"
      : `target contract ${describe(
          target
        )} does not match the canonical router ${canonical}`,
  };
}

interface TokenIsCanonicalCodes {
  readonly pass: string;
  readonly notCanonical: string;
  readonly sameAsOther: string;
  readonly registryMissing: string;
  readonly addressMalformed: string;
}

// Shared by token-in-is-canonical and token-out-is-canonical: each reads
// its own side of the swap plus the other side, so it can flag a swap
// naming the same contract on both sides before it ever reaches the
// registry lookup pay's asset-is-canonical already performs.
function makeTokenIsCanonicalChecker(
  id: string,
  tokenField: "tokenIn" | "tokenOut",
  otherField: "tokenIn" | "tokenOut",
  codes: TokenIsCanonicalCodes
): ConditionChecker {
  return function checkTokenIsCanonical(
    request: ConsultRequest,
    _context: ConditionContext
  ): CheckerOutcome {
    const { chainId } = request.action;
    const token = request.action[tokenField];
    const other = request.action[otherField];
    const symbol = token?.symbol;
    const contractAddress = token?.contractAddress;

    if (sameEvmAddress(contractAddress, other?.contractAddress) === true) {
      return {
        id,
        status: "FAIL",
        code: codes.sameAsOther,
        evidenceClass: "static-registry",
        evidence: `${tokenField} contract ${describe(
          contractAddress
        )} is the same contract as ${otherField}`,
      };
    }

    const byChain = ownLookup<Record<string, string>>(
      CANONICAL_ASSETS,
      chainId
    );
    const canonical = ownLookup<string>(byChain, symbol);
    if (canonical === undefined) {
      return {
        id,
        status: "UNVERIFIED",
        code: codes.registryMissing,
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
        code: codes.addressMalformed,
        evidenceClass: "not-verifiable",
        evidence: `${tokenField} contract address "${describe(
          contractAddress
        )}" is not a well-formed EVM address`,
      };
    }
    return {
      id,
      status: matches ? "PASS" : "FAIL",
      code: matches ? codes.pass : codes.notCanonical,
      evidenceClass: "static-registry",
      evidence: matches
        ? `${tokenField} contract matches the canonical entry`
        : `${tokenField} contract ${describe(
            contractAddress
          )} does not match the canonical entry ${canonical}`,
    };
  };
}

// Every declared FAIL code below is checked BEFORE the ceiling comparison,
// so a malformed number or a declared-vs-derived mismatch is always the
// reason reported, never masked by a coincidentally-passing ceiling check.
// The only division is by quotedOut, which is confirmed > 0n first.
function checkSlippageWithinCeiling(
  request: ConsultRequest,
  context: ConditionContext
): CheckerOutcome {
  const id = "slippage-within-ceiling";
  const { quotedOut, minOut, slippageBps } = request.action;
  const maxSlippageBps = context.policy.maxSlippageBps;

  if (
    typeof quotedOut !== "string" ||
    !AMOUNT_SHAPE.test(quotedOut) ||
    typeof minOut !== "string" ||
    !AMOUNT_SHAPE.test(minOut)
  ) {
    return {
      id,
      status: "FAIL",
      code: "SLIPPAGE_AMOUNTS_MALFORMED",
      evidenceClass: "owner-policy",
      evidence: `quotedOut "${describe(quotedOut)}" or minOut "${describe(
        minOut
      )}" is not a well-formed non-negative integer string`,
    };
  }

  const quotedOutValue = BigInt(quotedOut);
  const minOutValue = BigInt(minOut);

  if (quotedOutValue === 0n) {
    return {
      id,
      status: "FAIL",
      code: "SLIPPAGE_QUOTED_OUT_ZERO",
      evidenceClass: "owner-policy",
      evidence: "a quotedOut of 0 is never what the owner approved",
    };
  }
  if (minOutValue === 0n) {
    return {
      id,
      status: "FAIL",
      code: "SLIPPAGE_MIN_OUT_ZERO",
      evidenceClass: "owner-policy",
      evidence: "a minOut of 0 is never what the owner approved",
    };
  }
  if (minOutValue > quotedOutValue) {
    return {
      id,
      status: "FAIL",
      code: "SLIPPAGE_MIN_OUT_EXCEEDS_QUOTE",
      evidenceClass: "owner-policy",
      evidence: `minOut ${describe(minOut)} exceeds quotedOut ${describe(
        quotedOut
      )}`,
    };
  }
  if (
    typeof slippageBps !== "number" ||
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > 10000
  ) {
    return {
      id,
      status: "FAIL",
      code: "SLIPPAGE_BPS_MALFORMED",
      evidenceClass: "owner-policy",
      evidence: `slippageBps ${describe(
        slippageBps
      )} is not an integer in 0..10000`,
    };
  }

  const derivedBps = ((quotedOutValue - minOutValue) * 10000n) / quotedOutValue;
  const declaredBps = BigInt(slippageBps);
  if (derivedBps !== declaredBps) {
    return {
      id,
      status: "FAIL",
      code: "SLIPPAGE_DECLARED_MISMATCH",
      evidenceClass: "owner-policy",
      evidence: `declared slippageBps ${describe(
        slippageBps
      )} does not match the derived ${derivedBps.toString()} basis points`,
    };
  }

  if (
    typeof maxSlippageBps !== "number" ||
    !Number.isInteger(maxSlippageBps) ||
    maxSlippageBps < 0 ||
    maxSlippageBps > 10000
  ) {
    return {
      id,
      status: "UNVERIFIED",
      code: "SLIPPAGE_CEILING_MISSING",
      evidenceClass: "not-verifiable",
      evidence:
        "policy maxSlippageBps is not configured as an integer in 0..10000",
    };
  }

  // Cross-multiplied, so nothing is rounded: derivedBps rounds down, and a
  // swap a fraction of a basis point over the ceiling is still over it.
  const within =
    (quotedOutValue - minOutValue) * 10000n <=
    BigInt(maxSlippageBps) * quotedOutValue;
  return {
    id,
    status: within ? "PASS" : "FAIL",
    code: within ? "SLIPPAGE_WITHIN_CEILING" : "SLIPPAGE_EXCEEDS_CEILING",
    evidenceClass: within ? "caller-stated" : "owner-policy",
    evidence: within
      ? `slippage against the stated quote is ${derivedBps.toString()} bps, within the ceiling ${describe(
          maxSlippageBps
        )}`
      : `slippage against the stated quote is at least ${derivedBps.toString()} bps, above the ceiling ${describe(
          maxSlippageBps
        )}`,
  };
}

// facts.now is the only clock consult() ever sees. This Condition and
// role-requirement-met are the only ones that read it.
function checkDeadlineSetAndFresh(
  request: ConsultRequest,
  context: ConditionContext
): CheckerOutcome {
  const id = "deadline-set-and-fresh";
  const { deadline } = request.action;
  const maxDeadlineSeconds = context.policy.maxDeadlineSeconds;

  if (typeof deadline !== "number" || !Number.isSafeInteger(deadline)) {
    return {
      id,
      status: "UNVERIFIED",
      code: "DEADLINE_MALFORMED",
      evidenceClass: "not-verifiable",
      evidence: `deadline "${describe(deadline)}" is not a safe integer`,
    };
  }

  const now = readFactNow(context.facts);
  if (now === undefined) {
    return {
      id,
      status: "UNVERIFIED",
      code: "DEADLINE_NOW_UNAVAILABLE",
      evidenceClass: "not-verifiable",
      evidence:
        "cannot confirm the current time to compare against the deadline",
    };
  }

  if (
    typeof maxDeadlineSeconds !== "number" ||
    !Number.isInteger(maxDeadlineSeconds) ||
    maxDeadlineSeconds <= 0
  ) {
    return {
      id,
      status: "UNVERIFIED",
      code: "DEADLINE_CEILING_MISSING",
      evidenceClass: "not-verifiable",
      evidence:
        "policy maxDeadlineSeconds is not configured as a positive integer",
    };
  }

  if (deadline <= now) {
    return {
      id,
      status: "FAIL",
      code: "DEADLINE_PAST",
      evidenceClass: "owner-policy",
      evidence: `deadline ${describe(
        deadline
      )} is not after the current time ${describe(now)}`,
    };
  }

  const within = deadline - now <= maxDeadlineSeconds;
  return {
    id,
    status: within ? "PASS" : "FAIL",
    code: within ? "DEADLINE_FRESH" : "DEADLINE_TOO_FAR",
    evidenceClass: "owner-policy",
    evidence: within
      ? `deadline ${describe(deadline)} is fresh and within the owner's window`
      : `deadline ${describe(deadline)} is more than ${describe(
          maxDeadlineSeconds
        )} seconds out`,
  };
}

// Folds two questions into one Condition, since swap's Floor names no
// separate poison-derived check the way pay's does: is the output
// recipient an address the owner actually holds, and is it free of any
// recorded poison transfer.
function checkOutputRecipientIsOwner(
  request: ConsultRequest,
  context: ConditionContext
): CheckerOutcome {
  const id = "output-recipient-is-owner";
  const { recipient, chainId } = request.action;
  const { ownerAddresses } = context.policy;

  const shapeError = recipientShapeError(recipient, chainId, {
    chainUnsupported: "SWAP_RECIPIENT_CHAIN_UNSUPPORTED",
    shapeInvalid: "SWAP_RECIPIENT_SHAPE_INVALID",
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
  if (poisoned) {
    return {
      id,
      status: "FAIL",
      code: "SWAP_RECIPIENT_POISON_DERIVED",
      evidenceClass: "static-registry",
      evidence: `recipient ${describe(
        recipient
      )} was first seen through a poison transfer`,
    };
  }

  if (
    !Array.isArray(ownerAddresses) ||
    ownerAddresses.length === 0 ||
    ownerAddresses.some(
      (entry) => typeof entry !== "string" || entry.length === 0
    )
  ) {
    return {
      id,
      status: "UNVERIFIED",
      code: "SWAP_OWNER_ADDRESSES_INVALID",
      evidenceClass: "not-verifiable",
      evidence:
        "policy ownerAddresses is not a well-formed, non-empty list of strings",
    };
  }

  const matched = ownerAddresses.some(
    (entry) => sameEvmAddress(recipient, entry) === true
  );
  return {
    id,
    status: matched ? "PASS" : "FAIL",
    code: matched
      ? "SWAP_OUTPUT_RECIPIENT_IS_OWNER"
      : "SWAP_OUTPUT_RECIPIENT_NOT_OWNER",
    evidenceClass: "owner-policy",
    evidence: matched
      ? "recipient matches an owner address"
      : `recipient ${describe(recipient)} does not match an owner address`,
  };
}

// The approval a swap spends must cover exactly this swap's input amount:
// larger leaves a standing allowance behind, smaller cannot execute the
// swap it names.
function checkApprovalScopedToThisSwap(
  request: ConsultRequest,
  _context: ConditionContext
): CheckerOutcome {
  const id = "approval-scoped-to-this-swap";
  const { approvalAmount, amountIn } = request.action;

  if (
    typeof approvalAmount !== "string" ||
    !AMOUNT_SHAPE.test(approvalAmount) ||
    typeof amountIn !== "string" ||
    !AMOUNT_SHAPE.test(amountIn)
  ) {
    return {
      id,
      status: "UNVERIFIED",
      code: "SWAP_APPROVAL_MALFORMED",
      evidenceClass: "not-verifiable",
      evidence: `approvalAmount "${describe(
        approvalAmount
      )}" or amountIn "${describe(
        amountIn
      )}" is not a well-formed non-negative integer string`,
    };
  }

  const matches = BigInt(approvalAmount) === BigInt(amountIn);
  return {
    id,
    status: matches ? "PASS" : "FAIL",
    code: matches ? "SWAP_APPROVAL_SCOPED" : "SWAP_APPROVAL_NOT_SCOPED",
    evidenceClass: "owner-policy",
    evidence: matches
      ? "approval amount matches amountIn exactly"
      : `approval amount ${describe(
          approvalAmount
        )} does not match amountIn ${describe(amountIn)}`,
  };
}

const SWAP_FLOOR: ConditionDefinition[] = [
  {
    id: "target-is-canonical",
    isFloor: true,
    question: "Does the transaction call a canonical router?",
    reference: `${SWAP_REFERENCE_ROOT}/target-is-canonical.md`,
    codes: {
      pass: "SWAP_TARGET_IS_CANONICAL",
      fail: ["SWAP_TARGET_NOT_CANONICAL"],
      unverified: [
        "SWAP_TARGET_SHAPE_INVALID",
        "SWAP_TARGET_CHAIN_UNSUPPORTED",
        "SWAP_TARGET_ROUTER_UNKNOWN",
      ],
    },
    codeEvidenceClass: {
      SWAP_TARGET_IS_CANONICAL: "static-registry",
      SWAP_TARGET_NOT_CANONICAL: "static-registry",
      SWAP_TARGET_SHAPE_INVALID: "not-verifiable",
      SWAP_TARGET_CHAIN_UNSUPPORTED: "not-verifiable",
      SWAP_TARGET_ROUTER_UNKNOWN: "not-verifiable",
    },
    check: checkSwapTargetIsCanonical,
  },
  {
    id: "token-in-is-canonical",
    isFloor: true,
    question: "Does the input token contract match the canonical entry?",
    reference: `${SWAP_REFERENCE_ROOT}/token-in-is-canonical.md`,
    codes: {
      pass: "SWAP_TOKEN_IN_IS_CANONICAL",
      fail: ["SWAP_TOKEN_IN_NOT_CANONICAL", "SWAP_TOKEN_IN_SAME_AS_TOKEN_OUT"],
      unverified: [
        "SWAP_TOKEN_IN_REGISTRY_ENTRY_MISSING",
        "SWAP_TOKEN_IN_ADDRESS_MALFORMED",
      ],
    },
    codeEvidenceClass: {
      SWAP_TOKEN_IN_IS_CANONICAL: "static-registry",
      SWAP_TOKEN_IN_NOT_CANONICAL: "static-registry",
      SWAP_TOKEN_IN_SAME_AS_TOKEN_OUT: "static-registry",
      SWAP_TOKEN_IN_REGISTRY_ENTRY_MISSING: "not-verifiable",
      SWAP_TOKEN_IN_ADDRESS_MALFORMED: "not-verifiable",
    },
    check: makeTokenIsCanonicalChecker(
      "token-in-is-canonical",
      "tokenIn",
      "tokenOut",
      {
        pass: "SWAP_TOKEN_IN_IS_CANONICAL",
        notCanonical: "SWAP_TOKEN_IN_NOT_CANONICAL",
        sameAsOther: "SWAP_TOKEN_IN_SAME_AS_TOKEN_OUT",
        registryMissing: "SWAP_TOKEN_IN_REGISTRY_ENTRY_MISSING",
        addressMalformed: "SWAP_TOKEN_IN_ADDRESS_MALFORMED",
      }
    ),
  },
  {
    id: "token-out-is-canonical",
    isFloor: true,
    question: "Does the output token contract match the canonical entry?",
    reference: `${SWAP_REFERENCE_ROOT}/token-out-is-canonical.md`,
    codes: {
      pass: "SWAP_TOKEN_OUT_IS_CANONICAL",
      fail: ["SWAP_TOKEN_OUT_NOT_CANONICAL", "SWAP_TOKEN_OUT_SAME_AS_TOKEN_IN"],
      unverified: [
        "SWAP_TOKEN_OUT_REGISTRY_ENTRY_MISSING",
        "SWAP_TOKEN_OUT_ADDRESS_MALFORMED",
      ],
    },
    codeEvidenceClass: {
      SWAP_TOKEN_OUT_IS_CANONICAL: "static-registry",
      SWAP_TOKEN_OUT_NOT_CANONICAL: "static-registry",
      SWAP_TOKEN_OUT_SAME_AS_TOKEN_IN: "static-registry",
      SWAP_TOKEN_OUT_REGISTRY_ENTRY_MISSING: "not-verifiable",
      SWAP_TOKEN_OUT_ADDRESS_MALFORMED: "not-verifiable",
    },
    check: makeTokenIsCanonicalChecker(
      "token-out-is-canonical",
      "tokenOut",
      "tokenIn",
      {
        pass: "SWAP_TOKEN_OUT_IS_CANONICAL",
        notCanonical: "SWAP_TOKEN_OUT_NOT_CANONICAL",
        sameAsOther: "SWAP_TOKEN_OUT_SAME_AS_TOKEN_IN",
        registryMissing: "SWAP_TOKEN_OUT_REGISTRY_ENTRY_MISSING",
        addressMalformed: "SWAP_TOKEN_OUT_ADDRESS_MALFORMED",
      }
    ),
  },
  {
    id: "slippage-within-ceiling",
    isFloor: true,
    question: "Is the declared slippage within the owner's ceiling?",
    reference: `${SWAP_REFERENCE_ROOT}/slippage-within-ceiling.md`,
    codes: {
      pass: "SLIPPAGE_WITHIN_CEILING",
      fail: [
        "SLIPPAGE_AMOUNTS_MALFORMED",
        "SLIPPAGE_QUOTED_OUT_ZERO",
        "SLIPPAGE_MIN_OUT_ZERO",
        "SLIPPAGE_MIN_OUT_EXCEEDS_QUOTE",
        "SLIPPAGE_BPS_MALFORMED",
        "SLIPPAGE_DECLARED_MISMATCH",
        "SLIPPAGE_EXCEEDS_CEILING",
      ],
      unverified: ["SLIPPAGE_CEILING_MISSING"],
    },
    codeEvidenceClass: {
      SLIPPAGE_WITHIN_CEILING: "caller-stated",
      SLIPPAGE_AMOUNTS_MALFORMED: "owner-policy",
      SLIPPAGE_QUOTED_OUT_ZERO: "owner-policy",
      SLIPPAGE_MIN_OUT_ZERO: "owner-policy",
      SLIPPAGE_MIN_OUT_EXCEEDS_QUOTE: "owner-policy",
      SLIPPAGE_BPS_MALFORMED: "owner-policy",
      SLIPPAGE_DECLARED_MISMATCH: "owner-policy",
      SLIPPAGE_EXCEEDS_CEILING: "owner-policy",
      SLIPPAGE_CEILING_MISSING: "not-verifiable",
    },
    check: checkSlippageWithinCeiling,
  },
  {
    id: "deadline-set-and-fresh",
    isFloor: true,
    question:
      "Is the deadline set, in the future, and within the owner's window?",
    reference: `${SWAP_REFERENCE_ROOT}/deadline-set-and-fresh.md`,
    codes: {
      pass: "DEADLINE_FRESH",
      fail: ["DEADLINE_PAST", "DEADLINE_TOO_FAR"],
      unverified: [
        "DEADLINE_MALFORMED",
        "DEADLINE_NOW_UNAVAILABLE",
        "DEADLINE_CEILING_MISSING",
      ],
    },
    codeEvidenceClass: {
      DEADLINE_FRESH: "owner-policy",
      DEADLINE_PAST: "owner-policy",
      DEADLINE_TOO_FAR: "owner-policy",
      DEADLINE_MALFORMED: "not-verifiable",
      DEADLINE_NOW_UNAVAILABLE: "not-verifiable",
      DEADLINE_CEILING_MISSING: "not-verifiable",
    },
    check: checkDeadlineSetAndFresh,
  },
  {
    id: "output-recipient-is-owner",
    isFloor: true,
    question:
      "Does the output land on an address the owner holds, free of any recorded poison transfer?",
    reference: `${SWAP_REFERENCE_ROOT}/output-recipient-is-owner.md`,
    codes: {
      pass: "SWAP_OUTPUT_RECIPIENT_IS_OWNER",
      fail: [
        "SWAP_OUTPUT_RECIPIENT_NOT_OWNER",
        "SWAP_RECIPIENT_POISON_DERIVED",
      ],
      unverified: [
        "SWAP_RECIPIENT_SHAPE_INVALID",
        "SWAP_RECIPIENT_CHAIN_UNSUPPORTED",
        "SWAP_OWNER_ADDRESSES_INVALID",
      ],
    },
    codeEvidenceClass: {
      SWAP_OUTPUT_RECIPIENT_IS_OWNER: "owner-policy",
      SWAP_OUTPUT_RECIPIENT_NOT_OWNER: "owner-policy",
      SWAP_RECIPIENT_POISON_DERIVED: "static-registry",
      SWAP_RECIPIENT_SHAPE_INVALID: "not-verifiable",
      SWAP_RECIPIENT_CHAIN_UNSUPPORTED: "not-verifiable",
      SWAP_OWNER_ADDRESSES_INVALID: "not-verifiable",
    },
    check: checkOutputRecipientIsOwner,
  },
  {
    id: "approval-scoped-to-this-swap",
    isFloor: true,
    question: "Does the approval cover exactly this swap's input amount?",
    reference: `${SWAP_REFERENCE_ROOT}/approval-scoped-to-this-swap.md`,
    codes: {
      pass: "SWAP_APPROVAL_SCOPED",
      fail: ["SWAP_APPROVAL_NOT_SCOPED"],
      unverified: ["SWAP_APPROVAL_MALFORMED"],
    },
    codeEvidenceClass: {
      SWAP_APPROVAL_SCOPED: "owner-policy",
      SWAP_APPROVAL_NOT_SCOPED: "owner-policy",
      SWAP_APPROVAL_MALFORMED: "not-verifiable",
    },
    check: checkApprovalScopedToThisSwap,
  },
  {
    id: "amount-within-cap",
    isFloor: true,
    question:
      "Is the input amount above zero and within the owner's cap for this action?",
    reference: `${SWAP_REFERENCE_ROOT}/amount-within-cap.md`,
    codes: {
      pass: "SWAP_AMOUNT_WITHIN_CAP",
      fail: ["SWAP_AMOUNT_EXCEEDS_CAP", "SWAP_AMOUNT_ZERO"],
      unverified: ["SWAP_CAP_MISSING", "SWAP_AMOUNT_MALFORMED"],
    },
    codeEvidenceClass: {
      SWAP_AMOUNT_WITHIN_CAP: "owner-policy",
      SWAP_AMOUNT_EXCEEDS_CAP: "owner-policy",
      SWAP_AMOUNT_ZERO: "owner-policy",
      SWAP_CAP_MISSING: "not-verifiable",
      SWAP_AMOUNT_MALFORMED: "not-verifiable",
    },
    check: makeAmountWithinCapChecker("amount-within-cap", "amountIn", {
      pass: "SWAP_AMOUNT_WITHIN_CAP",
      exceeds: "SWAP_AMOUNT_EXCEEDS_CAP",
      zero: "SWAP_AMOUNT_ZERO",
      capMissing: "SWAP_CAP_MISSING",
      malformed: "SWAP_AMOUNT_MALFORMED",
    }),
  },
  {
    id: "chain-matches-intent",
    isFloor: true,
    question: "Does the request's chain match the owner's named chain?",
    reference: `${SWAP_REFERENCE_ROOT}/chain-matches-intent.md`,
    codes: {
      pass: "SWAP_CHAIN_MATCHES_INTENT",
      fail: ["SWAP_CHAIN_MISMATCH"],
      unverified: ["SWAP_CHAIN_ID_MALFORMED"],
    },
    codeEvidenceClass: {
      SWAP_CHAIN_MATCHES_INTENT: "owner-policy",
      SWAP_CHAIN_MISMATCH: "owner-policy",
      SWAP_CHAIN_ID_MALFORMED: "not-verifiable",
    },
    check: makeChainMatchesIntentChecker("chain-matches-intent", {
      pass: "SWAP_CHAIN_MATCHES_INTENT",
      mismatch: "SWAP_CHAIN_MISMATCH",
      malformed: "SWAP_CHAIN_ID_MALFORMED",
    }),
  },
  {
    id: "role-requirement-met",
    isFloor: true,
    question: "Is the owner's role requirement met?",
    reference: `${SWAP_REFERENCE_ROOT}/role-requirement-met.md`,
    codes: {
      pass: ["SWAP_ROLE_NOT_REQUIRED", "SWAP_ROLE_HELD"],
      fail: [
        "SWAP_ROLE_DISABLED",
        "SWAP_ROLE_MEMBERSHIP_EXPIRED",
        "SWAP_ROLE_MEMBER_MISSING",
      ],
      unverified: [
        "SWAP_ROLE_POLICY_MISSING",
        "SWAP_ROLE_POLICY_MALFORMED",
        "SWAP_ROLE_FACT_MISSING",
        "SWAP_ROLE_FACT_MALFORMED",
        "SWAP_ROLE_FACT_SUBJECT_MISMATCH",
        "SWAP_ROLE_FACT_AGE_UNKNOWN",
        "SWAP_ROLE_FACT_STALE",
      ],
    },
    codeEvidenceClass: {
      SWAP_ROLE_NOT_REQUIRED: "owner-policy",
      SWAP_ROLE_HELD: "onchain-read",
      SWAP_ROLE_DISABLED: "onchain-read",
      SWAP_ROLE_MEMBERSHIP_EXPIRED: "onchain-read",
      SWAP_ROLE_MEMBER_MISSING: "onchain-read",
      SWAP_ROLE_POLICY_MISSING: "not-verifiable",
      SWAP_ROLE_POLICY_MALFORMED: "not-verifiable",
      SWAP_ROLE_FACT_MISSING: "not-verifiable",
      SWAP_ROLE_FACT_MALFORMED: "not-verifiable",
      SWAP_ROLE_FACT_SUBJECT_MISMATCH: "not-verifiable",
      SWAP_ROLE_FACT_AGE_UNKNOWN: "not-verifiable",
      SWAP_ROLE_FACT_STALE: "not-verifiable",
    },
    check: makeRoleRequirementMetChecker("role-requirement-met", {
      notRequired: "SWAP_ROLE_NOT_REQUIRED",
      held: "SWAP_ROLE_HELD",
      disabled: "SWAP_ROLE_DISABLED",
      membershipExpired: "SWAP_ROLE_MEMBERSHIP_EXPIRED",
      memberMissing: "SWAP_ROLE_MEMBER_MISSING",
      policyMissing: "SWAP_ROLE_POLICY_MISSING",
      policyMalformed: "SWAP_ROLE_POLICY_MALFORMED",
      factMissing: "SWAP_ROLE_FACT_MISSING",
      factMalformed: "SWAP_ROLE_FACT_MALFORMED",
      subjectMismatch: "SWAP_ROLE_FACT_SUBJECT_MISMATCH",
      ageUnknown: "SWAP_ROLE_FACT_AGE_UNKNOWN",
      stale: "SWAP_ROLE_FACT_STALE",
    }),
  },
];

// The catalog consult() actually binds to: every action type this repo
// knows, in one frozen table. A caller never chooses this object; index.ts
// is the only place it is passed to makeConsult.
export const CATALOG: Catalog = deepFreeze({
  pay: PAY_FLOOR,
  swap: SWAP_FLOOR,
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
  if (
    (typeof pass !== "string" && !Array.isArray(pass)) ||
    (Array.isArray(pass) && pass.length === 0)
  ) {
    return `catalog Condition "${conditionId}" must declare at least one PASS code`;
  }
  const passList = passCodesOf({ pass } as Pick<ConditionCodes, "pass">);
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
  const allCodes = [...passList, ...fail, ...unverified];
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
    const evidenceClass = Object.hasOwn(classTable, code)
      ? classTable[code]
      : undefined;
    if (
      typeof evidenceClass !== "string" ||
      !Object.hasOwn(EVIDENCE_CLASS_WEIGHTS, evidenceClass)
    ) {
      return `catalog Condition "${conditionId}" has no valid evidence class for code "${code}"`;
    }
    if (passList.includes(code) && evidenceClass === "not-verifiable") {
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
assertValidCatalog(CATALOG);
