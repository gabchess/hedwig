# token-out-is-canonical

The output token's contract address is checked against a fixed registry of
canonical deployment addresses, keyed by chain and symbol, and against the
input token's own contract. The check flags a fake or copy-cat token
contract that reuses a real symbol, and a swap that names the same
contract on both sides.

When the fixed table has no entry for the chain and symbol, a signed
registry row passed in as `facts.registryAsset` can fill the gap, through
the same `canonicalAddressFor` lookup the other token Conditions use. The
fixed table always wins over a row. A row for another chain or symbol, an
expired row, a row with no `facts.now` to date it, or a malformed row
counts as no row at all.

- PASS: the contract address matches the registry's canonical entry and
  differs from the input token's contract.
- FAIL: the contract address names the same contract as the input token,
  or is well-formed but does not match the canonical entry.
- UNVERIFIED: there is no registry entry for the chain and symbol, or the
  contract address is not well-formed, or a registry row is in use and its
  live read of the deployed contract either disagrees with the row
  (`SWAP_TOKEN_OUT_LIVE_READ_DISAGREES_WITH_REGISTRY`) or did not complete
  (`SWAP_TOKEN_OUT_IMPLEMENTATION_UNCONFIRMED`).

## Sources

- Circle Developer Docs, "USDC Contract Addresses": https://developers.circle.com/stablecoins/usdc-contract-addresses
- weth.io, canonical WETH contract addresses by chain: https://weth.io
- Base, "Base Contracts", the chain's own list of its core contract addresses, including WETH: https://docs.base.org/base-chain/network-information/base-contracts
