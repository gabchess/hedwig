# asset-liquidity-sufficient

A pay asset with no code-table entry and no confirmed registry row at the
request's own address is an unknown token. For an unknown token this check
reads the USD value of its pools from `facts.marketSignals.liquidity` and
compares it with two lines from the service's params bundle: a deny line
and a pass line. The check flags a token with too little liquidity to be a
real asset. Thin liquidity is cheap for an attacker to fake, so a PASS here
proves this one dimension and never the token's identity: an unknown token
that passes all three market checks is still `UNKNOWN`.

The reading comes from the owner's own RPC (pool balances through
`eth_call`). A value from a hosted index never enters the Fact. The reading
must name the request's chain and asset address, and its `readAt` must be
no more than 60 seconds before `facts.now`. The thresholds reach the check
only through `context.param`; no threshold value is in this repository.

- PASS: the asset is known (`ASSET_LIQUIDITY_NOT_REQUIRED`, no reading
  needed), or the liquidity is at or above the pass line.
- FAIL: the liquidity is under the deny line.
- UNVERIFIED: the liquidity is between the two lines (the `UNKNOWN` band);
  there is no params bundle or no usable threshold; the reading is missing,
  malformed, about another token, older than 60 seconds, dated after
  `facts.now`, or there is no `facts.now` to date it.

## Sources

- Ethereum JSON-RPC API, `eth_call`: https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_call
