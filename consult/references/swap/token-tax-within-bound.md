# token-tax-within-bound

A token can take a transfer tax: part of every transfer never arrives. A swap
pays the tax of both legs out of one trade, the sell tax on the token it
spends and the buy tax on the token it receives. This check adds the two
taxes to the honest tolerance (`tolerance_floor_bps`, the lower bound that
needs no volatility read) and compares the total with one bound from the
params bundle. It never reads a request field for the tax: the tax is a Fact
in `facts.tokenTax`, one entry per token with its chain, address, `taxBps`,
`sellBlocked`, `asOf` and `source`.

The bound is `tax_plus_honest_tolerance_max_bps` when both legs are named by
the code table, or by a registry row with a confirmed live read, at their
exact address. If either leg is not, the bound is
`tax_plus_honest_tolerance_deny_above_bps`. A total at the bound is within it.

Order of the check:

1. A `sellBlocked` entry for either leg, matched by chain and address, is
   FAIL (`SWAP_TOKEN_SELL_BLOCKED`) whatever the bound, the age or any other
   field, and with no params bundle. A probe that bought the token could not
   sell it back.
2. Each leg needs exactly one entry. None is UNVERIFIED
   (`SWAP_TAX_FACT_MISSING`), which covers a native-asset leg, a leg with a
   malformed address and a Fact for another token or chain. Two entries for
   one token are UNVERIFIED (`SWAP_TAX_FACT_AMBIGUOUS`).
3. Each entry must be well formed: `taxBps` a whole number from 0 to 10000,
   `sellBlocked` a boolean, `asOf` a unix second, `source` either
   `simulation` or `canonical`.
4. A `canonical` entry counts only when the token is named at that exact
   address and `taxBps` is 0. Any other `canonical` entry is UNVERIFIED
   (`SWAP_TAX_CANONICAL_UNCONFIRMED`).
5. The reading must be no older than 60 seconds against `facts.now`. A reading
   dated after `facts.now`, or with no valid `facts.now`, has an unknown age.
6. Both constants must be in the bundle as non-negative numbers, else
   UNVERIFIED (`SWAP_TAX_BOUND_MISSING`).
7. Tax in plus tax out plus the tolerance floor, above the bound, is FAIL
   (`SWAP_TAX_EXCEEDS_BOUND`). Otherwise PASS.

A PASS is `static-registry` when both legs read `canonical`, and `simulated`
when either leg holds a simulation reading, the weaker class. A simulation
can be fooled by a token built to detect it, and a tax that varies by sender
or by time shows only the sample the probe saw.

## Sources

- Uniswap V2 periphery, `UniswapV2Router02.sol`, whose
  `...SupportingFeeOnTransferTokens` swap functions exist because a token can
  deliver less than the amount sent:
  https://github.com/Uniswap/v2-periphery/blob/master/contracts/UniswapV2Router02.sol
