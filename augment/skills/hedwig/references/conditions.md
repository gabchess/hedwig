# Conditions

Hedwig answers a request one Condition at a time. A Condition is a fixed
question about the request, a checker that answers it, and the codes that
checker may return. `consult(request, policy, facts)` runs every Condition
the catalog holds for the request's action type and returns one row per
Condition, carrying `id`, `question`, `status`, `code`, `evidence`,
`evidenceClass` and `reference`. Catalog text is fixed: a question is never
built from request text, and a returned code is looked up in the catalog's
own table rather than trusted as the checker reports it. This file is the
whole catalog: every Condition, its question word for word, its codes, and
the evidence class each code carries.

## What Hedwig reads

Three inputs and nothing else.

- `request.action`: `type`, `chainId`, `target`, `recipient`, `asset`
  (`symbol`, `contractAddress`), `amount`, `validBefore`, `tokenIn`,
  `tokenOut`, `amountIn`, `quotedOut`, `minOut`, `slippageBps`, `deadline`,
  `approvalAmount`.
- `policy`, the owner's file: `permits`, `chainId`, `approvedRecipients`,
  `perActionCaps`, `maxSlippageBps`, `maxDeadlineSeconds`, `ownerAddresses`,
  `role`, `authorizationWindow`.
- `facts`, supplied by the caller as data: `now` and `solanaRole`.
  `consult()` reads no clock and makes no network or RPC call, so a
  Condition that needs the current time or a chain observation reads it here
  or answers UNVERIFIED.

Every Condition below is a Floor Condition, so every row is mandatory for
its action type. Before any Condition runs, the core checks the request and
policy shape, the action type, and the presence of a Floor; a defect there
resolves to UNVERIFIED and names itself. See
[core input checks](../../../../consult/references/core.md).

## What PASS, FAIL and UNVERIFIED mean here

- PASS: the checker ran and the answer to its question is yes.
- FAIL: the checker ran and the answer is no. One FAIL on any row makes the
  verdict `DENY`.
- UNVERIFIED: the checker could not answer, because a field is missing,
  malformed, absent from the registry, or stale. A Floor row that is
  UNVERIFIED makes the verdict `UNKNOWN`.

`ALLOW_UNDER_POLICY` is the only verdict that is earned. It needs a
non-empty, all-PASS result set and a policy whose `permits` is true.
`proceed` is exactly `verdict === "ALLOW_UNDER_POLICY"`, and `proceed` is
what a caller acts on. `support` and `band` report how strong the proof
behind the PASS rows was; neither decides a verdict.

Each code carries one of five evidence classes: `onchain-read`,
`owner-policy`, `static-registry`, `caller-stated`, `not-verifiable`. Every
UNVERIFIED code carries `not-verifiable`, and the catalog rejects a PASS
code declared that way, so a PASS never rests on evidence that does not
exist.

## pay

| Condition | Question | PASS | FAIL | UNVERIFIED |
| --- | --- | --- | --- | --- |
| [`recipient-matches-policy`](../../../../consult/references/pay/recipient-matches-policy.md) | Does the recipient match an entry the owner approved? | `RECIPIENT_MATCHES_POLICY` (owner-policy) | `RECIPIENT_NOT_IN_POLICY` (owner-policy) | `RECIPIENT_SHAPE_INVALID`, `RECIPIENT_CHAIN_UNSUPPORTED`, `APPROVED_RECIPIENTS_INVALID` |
| [`recipient-not-poison-derived`](../../../../consult/references/pay/recipient-not-poison-derived.md) | Is the recipient free of any recorded poison transfer? | `RECIPIENT_NOT_POISON_DERIVED` (static-registry) | `RECIPIENT_POISON_DERIVED` (static-registry) | `POISON_CHECK_SHAPE_INVALID`, `POISON_CHECK_CHAIN_UNSUPPORTED` |
| [`asset-is-canonical`](../../../../consult/references/pay/asset-is-canonical.md) | Does the asset contract match the canonical entry? | `ASSET_IS_CANONICAL` (static-registry) | `ASSET_NOT_CANONICAL` (static-registry) | `ASSET_REGISTRY_ENTRY_MISSING`, `ASSET_ADDRESS_MALFORMED` |
| [`amount-within-cap`](../../../../consult/references/pay/amount-within-cap.md) | Is the amount above zero and within the owner's cap for this action? | `AMOUNT_WITHIN_CAP` (owner-policy) | `AMOUNT_EXCEEDS_CAP`, `AMOUNT_ZERO` (owner-policy) | `CAP_MISSING`, `AMOUNT_MALFORMED` |
| [`chain-matches-intent`](../../../../consult/references/pay/chain-matches-intent.md) | Does the request's chain match the owner's named chain? | `CHAIN_MATCHES_INTENT` (owner-policy) | `CHAIN_MISMATCH` (owner-policy) | `CHAIN_ID_MALFORMED` |
| [`target-is-canonical`](../../../../consult/references/pay/target-is-canonical.md) | Does the transaction call the canonical asset contract? | `TARGET_IS_CANONICAL` (static-registry) | `TARGET_NOT_CANONICAL` (static-registry) | `TARGET_SHAPE_INVALID`, `TARGET_CHAIN_UNSUPPORTED`, `TARGET_REGISTRY_ENTRY_MISSING` |
| [`role-requirement-met`](../../../../consult/references/pay/role-requirement-met.md) | Is the owner's role requirement met? | `ROLE_NOT_REQUIRED` (owner-policy), `ROLE_HELD` (onchain-read) | `ROLE_DISABLED`, `ROLE_MEMBERSHIP_EXPIRED`, `ROLE_MEMBER_MISSING` (onchain-read) | `ROLE_POLICY_MISSING`, `ROLE_POLICY_MALFORMED`, `ROLE_FACT_MISSING`, `ROLE_FACT_MALFORMED`, `ROLE_FACT_SUBJECT_MISMATCH`, `ROLE_FACT_AGE_UNKNOWN`, `ROLE_FACT_STALE` |
| [`authorization-window-within-ceiling`](../../../../consult/references/pay/authorization-window-within-ceiling.md) | Is the authorization's validBefore within the owner's maximum authorization window? | `AUTHORIZATION_NOT_REQUIRED` (owner-policy), `AUTHORIZATION_WITHIN_CEILING` (owner-policy) | `AUTHORIZATION_WINDOW_PAST`, `AUTHORIZATION_WINDOW_EXCEEDS_CEILING` (owner-policy) | `AUTHORIZATION_POLICY_MISSING`, `AUTHORIZATION_POLICY_MALFORMED`, `AUTHORIZATION_CEILING_MISSING`, `AUTHORIZATION_CEILING_MALFORMED`, `AUTHORIZATION_MALFORMED`, `AUTHORIZATION_NOW_UNAVAILABLE` |

## swap

| Condition | Question | PASS | FAIL | UNVERIFIED |
| --- | --- | --- | --- | --- |
| [`target-is-canonical`](../../../../consult/references/swap/target-is-canonical.md) | Does the transaction call a canonical router? | `SWAP_TARGET_IS_CANONICAL` (static-registry) | `SWAP_TARGET_NOT_CANONICAL` (static-registry) | `SWAP_TARGET_SHAPE_INVALID`, `SWAP_TARGET_CHAIN_UNSUPPORTED`, `SWAP_TARGET_ROUTER_UNKNOWN` |
| [`token-in-is-canonical`](../../../../consult/references/swap/token-in-is-canonical.md) | Does the input token contract match the canonical entry? | `SWAP_TOKEN_IN_IS_CANONICAL` (static-registry) | `SWAP_TOKEN_IN_NOT_CANONICAL`, `SWAP_TOKEN_IN_SAME_AS_TOKEN_OUT` (static-registry) | `SWAP_TOKEN_IN_REGISTRY_ENTRY_MISSING`, `SWAP_TOKEN_IN_ADDRESS_MALFORMED` |
| [`token-out-is-canonical`](../../../../consult/references/swap/token-out-is-canonical.md) | Does the output token contract match the canonical entry? | `SWAP_TOKEN_OUT_IS_CANONICAL` (static-registry) | `SWAP_TOKEN_OUT_NOT_CANONICAL`, `SWAP_TOKEN_OUT_SAME_AS_TOKEN_IN` (static-registry) | `SWAP_TOKEN_OUT_REGISTRY_ENTRY_MISSING`, `SWAP_TOKEN_OUT_ADDRESS_MALFORMED` |
| [`slippage-within-ceiling`](../../../../consult/references/swap/slippage-within-ceiling.md) | Is the declared slippage within the owner's ceiling? | `SLIPPAGE_WITHIN_CEILING` (caller-stated) | `SLIPPAGE_AMOUNTS_MALFORMED`, `SLIPPAGE_QUOTED_OUT_ZERO`, `SLIPPAGE_MIN_OUT_ZERO`, `SLIPPAGE_MIN_OUT_EXCEEDS_QUOTE`, `SLIPPAGE_BPS_MALFORMED`, `SLIPPAGE_DECLARED_MISMATCH`, `SLIPPAGE_EXCEEDS_CEILING` (owner-policy) | `SLIPPAGE_CEILING_MISSING` |
| [`deadline-set-and-fresh`](../../../../consult/references/swap/deadline-set-and-fresh.md) | Is the deadline set, in the future, and within the owner's window? | `DEADLINE_FRESH` (owner-policy) | `DEADLINE_PAST`, `DEADLINE_TOO_FAR` (owner-policy) | `DEADLINE_MALFORMED`, `DEADLINE_NOW_UNAVAILABLE`, `DEADLINE_CEILING_MISSING` |
| [`output-recipient-is-owner`](../../../../consult/references/swap/output-recipient-is-owner.md) | Does the output land on an address the owner holds, free of any recorded poison transfer? | `SWAP_OUTPUT_RECIPIENT_IS_OWNER` (owner-policy) | `SWAP_OUTPUT_RECIPIENT_NOT_OWNER` (owner-policy), `SWAP_RECIPIENT_POISON_DERIVED` (static-registry) | `SWAP_RECIPIENT_SHAPE_INVALID`, `SWAP_RECIPIENT_CHAIN_UNSUPPORTED`, `SWAP_OWNER_ADDRESSES_INVALID` |
| [`approval-scoped-to-this-swap`](../../../../consult/references/swap/approval-scoped-to-this-swap.md) | Does the approval cover exactly this swap's input amount? | `SWAP_APPROVAL_SCOPED` (owner-policy) | `SWAP_APPROVAL_NOT_SCOPED` (owner-policy) | `SWAP_APPROVAL_MALFORMED` |
| [`amount-within-cap`](../../../../consult/references/swap/amount-within-cap.md) | Is the input amount above zero and within the owner's cap for this action? | `SWAP_AMOUNT_WITHIN_CAP` (owner-policy) | `SWAP_AMOUNT_EXCEEDS_CAP`, `SWAP_AMOUNT_ZERO` (owner-policy) | `SWAP_CAP_MISSING`, `SWAP_AMOUNT_MALFORMED` |
| [`chain-matches-intent`](../../../../consult/references/swap/chain-matches-intent.md) | Does the request's chain match the owner's named chain? | `SWAP_CHAIN_MATCHES_INTENT` (owner-policy) | `SWAP_CHAIN_MISMATCH` (owner-policy) | `SWAP_CHAIN_ID_MALFORMED` |
| [`role-requirement-met`](../../../../consult/references/swap/role-requirement-met.md) | Is the owner's role requirement met? | `SWAP_ROLE_NOT_REQUIRED` (owner-policy), `SWAP_ROLE_HELD` (onchain-read) | `SWAP_ROLE_DISABLED`, `SWAP_ROLE_MEMBERSHIP_EXPIRED`, `SWAP_ROLE_MEMBER_MISSING` (onchain-read) | `SWAP_ROLE_POLICY_MISSING`, `SWAP_ROLE_POLICY_MALFORMED`, `SWAP_ROLE_FACT_MISSING`, `SWAP_ROLE_FACT_MALFORMED`, `SWAP_ROLE_FACT_SUBJECT_MISMATCH`, `SWAP_ROLE_FACT_AGE_UNKNOWN`, `SWAP_ROLE_FACT_STALE` |

A code is unique across the whole catalog, so a code names one Condition and
one outcome. `pay` and `swap` share four Condition ids and no codes.

## Sources

- Condition ids, questions, codes and per-code evidence classes:
  `consult/src/catalog.ts`.
- The verdict rule and the evidence class list: `consult/src/fold.ts`.
- Evidence class weights and band edges: `consult/src/constants.ts`.
- `proceed` as `verdict === "ALLOW_UNDER_POLICY"`: `consult/src/core.ts`.
- The checks that run before any Condition:
  [`consult/references/core.md`](../../../../consult/references/core.md).
