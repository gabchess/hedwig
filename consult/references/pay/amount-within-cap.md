# amount-within-cap

The payment amount is checked against a fixed per-action-type cap the owner
sets in the policy, the same shape of limit an ERC-20 allowance places on
how much a spender may move. This prevents a single payment from moving more
value than the owner ever authorized for that action type.

- PASS: the amount is a well-formed non-negative integer no greater than the
  configured cap.
- FAIL: the amount exceeds the cap, or the amount is exactly zero.
- UNVERIFIED: no cap is configured for the action type, or the amount or the
  cap is not a well-formed non-negative integer string.

## Sources

- EIP-20: Token Standard, `approve` and `allowance`: https://eips.ethereum.org/EIPS/eip-20
