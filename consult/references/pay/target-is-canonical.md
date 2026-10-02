# target-is-canonical

The contract the transaction actually calls is checked against the same
canonical deployment registry `asset-is-canonical` reads, keyed by chain and
symbol. The check flags a payment that calls any contract other than the
asset's own canonical contract, even when the recipient, amount, and
declared asset all look correct.

When the fixed table has no entry for the chain and symbol, a signed
registry row passed in as `facts.registryAsset` can fill the gap, through
the same `canonicalAddressFor` lookup the other token Conditions use. The
fixed table always wins over a row. A row for another chain or symbol, a
row whose symbol is not ASCII uppercase letters and digits or is a fixed
table symbol in another letter case, an expired row, a row with no
`facts.now` to date it, a row with no `liveReadAt`, or a malformed row
counts as no row at all. A `confirmed` live read older than 60 seconds, or
dated after `facts.now`, counts as `unconfirmed`.

- PASS: the target contract matches the registry's canonical entry.
- FAIL: the target contract is well-formed but does not match the
  canonical entry.
- UNVERIFIED: the target is missing or not a well-formed address, the chain
  family is not supported, or there is no registry entry for the chain and
  symbol, or the target is the registry row's own address and the row's live
  read of the deployed contract either disagrees with the row
  (`TARGET_LIVE_READ_DISAGREES_WITH_REGISTRY`) or did not complete
  (`TARGET_IMPLEMENTATION_UNCONFIRMED`). The live-read codes apply only at
  the row's own address. Any other address is FAIL, whatever the live read
  says.

## Sources

- Circle Developer Docs, "USDC Contract Addresses": https://developers.circle.com/stablecoins/usdc-contract-addresses
