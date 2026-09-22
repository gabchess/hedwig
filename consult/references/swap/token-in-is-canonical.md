# token-in-is-canonical

The input token's contract address is checked against a fixed registry of
canonical deployment addresses, keyed by chain and symbol, and against the
output token's own contract. The check flags a fake or copy-cat token
contract that reuses a real symbol, and a swap that names the same
contract on both sides.

- PASS: the contract address matches the registry's canonical entry and
  differs from the output token's contract.
- FAIL: the contract address names the same contract as the output token,
  or is well-formed but does not match the canonical entry.
- UNVERIFIED: there is no registry entry for the chain and symbol, or the
  contract address is not well-formed.

## Sources

- Circle Developer Docs, "USDC Contract Addresses": https://developers.circle.com/stablecoins/usdc-contract-addresses
- weth.io, canonical WETH contract addresses by chain: https://weth.io
- Base, "Base Contracts", the chain's own list of its core contract addresses, including WETH: https://docs.base.org/base-chain/network-information/base-contracts
