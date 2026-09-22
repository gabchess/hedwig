# Approvals

An ERC-20 approval is a standing grant. `approve(spender, value)` lets
that spender withdraw from the owner's account multiple times, up to
`value`, and calling `approve` again overwrites the current allowance
with the new value. Nothing in the standard ties the grant to the
transaction that needed it: `allowance(owner, spender)` keeps returning
whatever remains until the spender withdraws it or the owner writes a new
value. An approval of the maximum uint256 value is the same shape taken
to its limit, a grant over the owner's whole balance of that token with
no end. The practice this file describes is the narrow one: approve the
exact amount the action spends, so the action consumes the allowance it
asked for, and write zero to leave the spender nothing to withdraw.

## Changing an allowance that is not zero

EIP-20 records an attack vector around changing an allowance from one
nonzero value to another, and describes the client practice it calls for:
set the allowance to zero first, then set the new value, for the same
spender. The standard leaves that two-step sequence to clients and states
that the contract itself does not enforce it, so contracts deployed
before the note keep working. ERC-2612 records that the same EIP-20
approval race applies to a signed `permit` as well. An approval equal to
the amount the action spends leaves no standing nonzero value to change.

## Signed approvals: permit

ERC-2612 adds three functions to an EIP-20 token: `permit(owner, spender,
value, deadline, v, r, s)`, `nonces(owner)`, and `DOMAIN_SEPARATOR()`. A
call to `permit` sets `allowance[owner][spender]` to `value`, increments
`nonces[owner]` by one, and emits an `Approval` event, and it does so
only when the current block time is at or below `deadline`, `owner` is
not the zero address, the signed nonce equals the current `nonces[owner]`
before the update, and `v`, `r` and `s` are a valid secp256k1 signature
from `owner` over the EIP-712 typed `Permit` message. If any of those
conditions is unmet, the call reverts. `DOMAIN_SEPARATOR` binds the
signature to one contract and one chain. The nonce makes each signed
permit spendable once. `deadline` bounds how long a signed permit stays
valid, and setting it to `uint(-1)` creates a permit that effectively
never expires. What `permit` writes is an allowance like any other: a
permit for more than the action spends leaves the same standing grant
behind that a direct `approve` would.

## Permit2

Permit2 is a separate contract, the union of `SignatureTransfer` and
`AllowanceTransfer`, and it works with any ERC-20, including tokens that
do not implement EIP-2612. Using it starts with one standard ERC-20
approval of the Permit2 contract per token, commonly for the maximum
uint256 amount. After that, per-spender permissions come from signatures
or from Permit2's own approve function, so an integrator does not trigger
a separate onchain approval for every spender.

The two modules differ in what they leave behind. `AllowanceTransfer`
stores a standing, time-bound allowance inside the Permit2 contract: an
amount and an expiration for a spender, which that spender draws on
through `transferFrom` until the allowance is exhausted or expires, with
an incrementing nonce per owner, token, and spender. `SignatureTransfer`
authorizes a single transfer against an unordered, single-use nonce
tracked in a bitmap, and the permission lasts only for the transaction in
which the signature is spent, so it leaves no standing allowance. Both
modules carry a signature deadline.

## What Hedwig reads

`consult()` makes no network or RPC call, so it reads no onchain
allowance. It reads the approval the request declares and compares it
with the swap the same request describes.

- `approval-scoped-to-this-swap`, a swap Floor Condition, asks "Does the
  approval cover exactly this swap's input amount?" It reads
  `request.action.approvalAmount` and `request.action.amountIn` and
  compares them as exact integers.
- `amount-within-cap`, the swap row beside it, asks "Is the input amount
  above zero and within the owner's cap for this action?" It reads
  `request.action.amountIn` against the owner's `policy.perActionCaps`
  entry for `request.action.type`. An approval equal to `amountIn` sits
  under the same cap the owner set for that action type.

A maximum-uint256 approval, the amount a Permit2 integration asks for on
the token contract itself, does not equal `amountIn`, so it is a FAIL row
here.

## What PASS, FAIL and UNVERIFIED mean here

- PASS (`SWAP_APPROVAL_SCOPED`, owner-policy): both amounts are
  well-formed non-negative integer strings, and the approval amount
  equals `amountIn` exactly.
- FAIL (`SWAP_APPROVAL_NOT_SCOPED`, owner-policy): both amounts are
  well-formed and they differ, larger or smaller. A larger approval
  leaves an allowance standing once the swap executes; a smaller one does
  not cover the swap it names. One FAIL row makes the verdict `DENY`.
- UNVERIFIED (`SWAP_APPROVAL_MALFORMED`, not-verifiable): the approval
  amount or the input amount is missing or is not a well-formed
  non-negative integer string. This row is on the swap Floor, so an
  UNVERIFIED answer makes the verdict `UNKNOWN` and `proceed` false.

## Sources

- EIP-20: Token Standard, `approve`, `allowance`, and the note on setting
  an allowance to zero before setting a new value:
  https://eips.ethereum.org/EIPS/eip-20
- ERC-2612: Permit Extension for EIP-20 Signed Approvals, `permit`,
  `nonces`, `DOMAIN_SEPARATOR`, `deadline`, and the note that the EIP-20
  approval race applies to `permit`:
  https://eips.ethereum.org/EIPS/eip-2612
- Permit2 Overview, Uniswap's own documentation, the two modules, the
  one-time per-token approval, nonces and expiration:
  https://docs.uniswap.org/contracts/permit2/overview
- Uniswap permit2 repository README, the architecture of
  `AllowanceTransfer` and `SignatureTransfer`:
  https://raw.githubusercontent.com/Uniswap/permit2/main/README.md
