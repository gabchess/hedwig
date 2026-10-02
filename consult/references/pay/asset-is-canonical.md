# asset-is-canonical

The asset's contract address is checked against a fixed registry of
canonical deployment addresses, keyed by chain and symbol. The check flags
a fake or copy-cat token contract that reuses a real symbol such as "USDC"
on the same chain.

When the fixed table has no entry for the chain and symbol, a signed
registry row passed in as `facts.registryAsset` can fill the gap, through
the same `canonicalAddressFor` lookup the other token Conditions use. The
fixed table always wins over a row. A row for another chain or symbol, a
row whose symbol is not ASCII uppercase letters and digits or is a fixed
table symbol in another letter case, an expired row, a row with no
`facts.now` to date it, a row with no `liveReadAt`, or a malformed row
counts as no row at all. A `confirmed` live read older than 60 seconds, or
dated after `facts.now`, counts as `unconfirmed`.

- PASS: the contract address matches the registry's canonical entry.
- FAIL: the contract address is well-formed but does not match the
  canonical entry.
- UNVERIFIED: there is no registry entry for the chain and symbol, or the
  contract address is not well-formed, or the address is the registry row's
  own address and the row's live read of the deployed contract either
  disagrees with the row (`ASSET_LIVE_READ_DISAGREES_WITH_REGISTRY`) or did
  not complete (`ASSET_IMPLEMENTATION_UNCONFIRMED`). The live-read codes
  apply only at the row's own address. Any other address is FAIL, whatever
  the live read says.

## Sources

- Circle Developer Docs, "USDC Contract Addresses": https://developers.circle.com/stablecoins/usdc-contract-addresses
- Base, "Base Contracts", the chain's own list of its core contract addresses, including WETH: https://docs.base.org/base-chain/network-information/base-contracts
