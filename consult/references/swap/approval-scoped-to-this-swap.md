# approval-scoped-to-this-swap

The token approval the swap spends is checked against the swap's own
input amount, compared as exact integers. The check flags an
approval that leaves a standing allowance behind after this swap executes,
including the unlimited-allowance pattern of approving the maximum
uint256 value.

- PASS: the approval amount is a well-formed non-negative integer that
  equals the input amount exactly.
- FAIL: the approval amount is well-formed but differs from the input
  amount, larger or smaller.
- UNVERIFIED: the approval amount or the input amount is not a well-formed
  non-negative integer string.

## Sources

- EIP-20: Token Standard, `approve` and `allowance`: https://eips.ethereum.org/EIPS/eip-20
