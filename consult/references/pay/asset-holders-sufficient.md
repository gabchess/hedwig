# asset-holders-sufficient

For an unknown pay asset (no code-table entry and no confirmed registry row
at the request's own address), this check reads the number of addresses
that hold a balance from `facts.marketSignals.holders` and compares it with
a deny line and a pass line from the service's params bundle. The check
flags a token that almost nobody holds. A holder count is cheap to inflate,
so a PASS proves this one dimension and never the token's identity: an
unknown token that passes all three market checks is still `UNKNOWN`.

The count comes from the owner's own RPC. A count from a hosted index never
enters the Fact, so on a chain with no RPC holder source this dimension is
left out and the check answers UNVERIFIED. The reading must name the
request's chain and asset address, and its `readAt` must be no more than 60
seconds before `facts.now`. The thresholds reach the check only through
`context.param`; no threshold value is in this repository.

- PASS: the asset is known (`ASSET_HOLDERS_NOT_REQUIRED`, no reading
  needed), or the holder count is at or above the pass line.
- FAIL: the holder count is under the deny line.
- UNVERIFIED: the count is between the two lines (the `UNKNOWN` band);
  there is no params bundle or no usable threshold; the reading is missing,
  malformed, about another token, older than 60 seconds, dated after
  `facts.now`, or there is no `facts.now` to date it.

## Sources

- Ethereum JSON-RPC API, `eth_call` and `eth_getLogs`: https://ethereum.org/en/developers/docs/apis/json-rpc/
