# slippage-within-ceiling

The declared slippage is derived from `quotedOut` and `minOut` and checked
against the owner's ceiling. The check flags a swap whose declared
slippage understates the actual gap between the quote and the floor it
accepts, and a swap whose real slippage exceeds what the owner allowed.

Every number in this check is compared as an integer; there is no
floating-point arithmetic and no division except by `quotedOut`, which is
confirmed above zero first.

- PASS: `quotedOut` and `minOut` are well-formed positive amounts,
  `minOut` is at or below `quotedOut`, the declared `slippageBps` is an
  integer in 0..10000 that matches the derived basis points exactly, and
  the derived basis points are at or below the owner's ceiling.
- FAIL: any amount is malformed, `quotedOut` or `minOut` is zero, `minOut`
  exceeds `quotedOut`, the declared `slippageBps` is not an integer in
  0..10000, the declared value does not match the derived one, or the
  derived slippage exceeds the ceiling.
- UNVERIFIED: the owner has not configured a slippage ceiling.

## Sources

- Uniswap Universal Router repository, describing the swap commands
  (`V3_SWAP_EXACT_IN`, `V2_SWAP_EXACT_IN`) an owner's minimum-output
  ceiling bounds: https://github.com/Uniswap/universal-router
