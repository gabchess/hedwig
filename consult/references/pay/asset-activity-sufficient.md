# asset-activity-sufficient

For an unknown pay asset (no code-table entry and no confirmed registry row
at the request's own address), this check reads the token's recent
transfers from `facts.marketSignals.activity` and flags a dead token. Only
a transfer inside the window, worth more than zero and at least the
qualifying minimum in USD, counts. A zero-value transfer never counts,
because zero-value transfers are the address-poisoning vector. Transfers
are cheap to fake, so a PASS proves this one dimension and never the
token's identity: an unknown token that passes all three market checks is
still `UNKNOWN`.

The transfers come from the owner's own RPC (`eth_getLogs`). The reading
lists every transfer its read saw from `since` to `readAt`, each with its
sender and its value in USD. It must name the request's chain and asset
address, its `readAt` must be no more than 60 seconds before `facts.now`,
and its `since` must be at or before the window's start. Recency counts
from `facts.now`. The window, the qualifying minimum, the number of
distinct senders and the recency line all reach the check only through
`context.param`; no threshold value is in this repository.

- PASS: the asset is known (`ASSET_ACTIVITY_NOT_REQUIRED`, no reading
  needed), or the qualifying transfers come from enough distinct senders
  and the newest is recent enough.
- FAIL: no qualifying transfer in the window.
- UNVERIFIED: qualifying transfers exist but fall short of the pass lines
  (the `UNKNOWN` band); the read does not cover the whole window; there is
  no params bundle or no usable threshold; the reading is missing,
  malformed, about another token, older than 60 seconds, dated after
  `facts.now`, or there is no `facts.now` to date it.

## Sources

- Ethereum JSON-RPC API, `eth_getLogs`: https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_getlogs
- EIP-20, the `Transfer` event a transfer read decodes: https://eips.ethereum.org/EIPS/eip-20
