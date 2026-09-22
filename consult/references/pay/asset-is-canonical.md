# asset-is-canonical

The asset's contract address is checked against a fixed registry of
canonical deployment addresses, keyed by chain and symbol. The check flags
a fake or copy-cat token contract that reuses a real symbol such as "USDC"
on the same chain.

- PASS: the contract address matches the registry's canonical entry.
- FAIL: the contract address is well-formed but does not match the
  canonical entry.
- UNVERIFIED: there is no registry entry for the chain and symbol, or the
  contract address is not well-formed.

## Sources

- Circle Developer Docs, "USDC Contract Addresses": https://developers.circle.com/stablecoins/usdc-contract-addresses
- Base, "Base Contracts", the chain's own list of its core contract addresses, including WETH: https://docs.base.org/base-chain/network-information/base-contracts
