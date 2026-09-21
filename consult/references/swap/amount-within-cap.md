# amount-within-cap (swap)

The swap's input amount is checked against a fixed per-action-type cap the
owner sets in the policy, the same shape of limit an ERC-20 allowance
places on how much a spender may move. The check flags a single swap that
moves more value than the owner authorized for the action type.

- PASS: the input amount is a well-formed non-negative integer no greater
  than the configured cap.
- FAIL: the input amount exceeds the cap, or the input amount is exactly
  zero.
- UNVERIFIED: no cap is configured for the action type, or the input
  amount or the cap is not a well-formed non-negative integer string.

## Sources

- EIP-20: Token Standard, `approve` and `allowance`: https://eips.ethereum.org/EIPS/eip-20
