# slippage-within-floor-ceiling

The floor's own slippage check, for a caller with no policy file. It runs
the same request checks as `slippage-within-ceiling` and compares the gap
between `quotedOut` and `minOut` with a ceiling that comes from the params
bundle (`tolerance_cap_deny_above_bps`), never from a policy and never from a
number in code. The quote is the caller's statement, so every row carries the
`caller-stated` evidence class.

A `minOut` of zero counts as unbounded tolerance and fails the check
whatever the ceiling, and whether or not the ceiling is present.

Every number is an integer. The comparison is cross-multiplied,
`(quotedOut - minOut) * 10000 <= ceiling * quotedOut`, so a gap a fraction of
a basis point over the ceiling is over it. A gap equal to the ceiling is
within it.

- PASS: `quotedOut` and `minOut` are well-formed positive amounts, `minOut`
  is at or below `quotedOut`, the declared `slippageBps` is an integer in
  0..10000 that matches the derived basis points exactly, and the gap is at
  or below the ceiling.
- FAIL: any amount is malformed, `quotedOut` or `minOut` is zero, `minOut`
  exceeds `quotedOut`, the declared `slippageBps` is not an integer in
  0..10000, the declared value does not match the derived one, or the gap
  exceeds the ceiling. Each has its own `SWAP_FLOOR_` code, so none shares a
  name with the owner's check, which means a different ceiling.
- UNVERIFIED: the ceiling is not in the params bundle as a whole number of
  basis points (`SWAP_FLOOR_CEILING_MISSING`). A bundle that is absent,
  partial or malformed, a constant that is missing, and a constant labelled
  for anything but `check` or `both` all read as missing.

## Sources

- Uniswap Universal Router repository, describing the swap commands
  (`V3_SWAP_EXACT_IN`, `V2_SWAP_EXACT_IN`) a minimum-output bound protects:
  https://github.com/Uniswap/universal-router
