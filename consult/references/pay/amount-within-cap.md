# amount-within-cap

The payment amount is checked against a fixed per-action-type cap the owner
sets in the policy, the same shape of limit an ERC-20 allowance places on
how much a spender may move. The check flags a single payment that moves
more value than the owner authorized for that action type.

A cap is a raw number in the base units of one asset, and base units differ
across assets (USDC has 6 decimals, WETH has 18). The policy names that asset
in `perActionCapAssets`, and the cap applies only to an amount of that asset.

- PASS: the amount is a well-formed non-negative integer no greater than the
  configured cap, and the request's asset is the asset the cap names.
- FAIL: the amount exceeds the cap, or the amount is exactly zero.
- UNVERIFIED: no cap is configured for the action type, the amount or the cap
  is not a well-formed non-negative integer string, the cap names no asset
  or a malformed one, the request's asset cannot be read, or the request's
  asset is not the asset the cap names.

## Sources

- EIP-20: Token Standard, `approve` and `allowance`: https://eips.ethereum.org/EIPS/eip-20
