# slippage-within-ceiling

The slippage is derived from the request's own `quotedOut` and `minOut`
and checked against the owner's ceiling. The check flags a swap whose
declared slippage differs from the gap between its quote and the floor it
accepts, and a swap whose gap is wider than the owner allows. The quote is
the caller's statement, so a PASS carries the `caller-stated` evidence
class.

Every number in this check is an integer. The ceiling comparison is
cross-multiplied, `(quotedOut - minOut) * 10000 <= ceiling * quotedOut`, so
nothing is rounded: a gap a fraction of a basis point over the ceiling is
over it. The derived basis points, rounded down, are what the declared
`slippageBps` must equal.

- PASS: `quotedOut` and `minOut` are well-formed positive amounts,
  `minOut` is at or below `quotedOut`, the declared `slippageBps` is an
  integer in 0..10000 that matches the derived basis points exactly, and
  the gap is at or below the owner's ceiling.
- FAIL: any amount is malformed, `quotedOut` or `minOut` is zero, `minOut`
  exceeds `quotedOut`, the declared `slippageBps` is not an integer in
  0..10000, the declared value does not match the derived one, or the gap
  exceeds the ceiling.
- UNVERIFIED: the owner has not configured a slippage ceiling.

## Sources

- Uniswap Universal Router repository, describing the swap commands
  (`V3_SWAP_EXACT_IN`, `V2_SWAP_EXACT_IN`) an owner's minimum-output
  ceiling bounds: https://github.com/Uniswap/universal-router
