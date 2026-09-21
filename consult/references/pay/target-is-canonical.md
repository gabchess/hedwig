# target-is-canonical

The contract the transaction actually calls is checked against the same
canonical deployment registry `asset-is-canonical` reads, keyed by chain and
symbol. The check flags a payment that calls any contract other than the
asset's own canonical contract, even when the recipient, amount, and
declared asset all look correct.

- PASS: the target contract matches the registry's canonical entry.
- FAIL: the target contract is well-formed but does not match the
  canonical entry.
- UNVERIFIED: the target is missing or not a well-formed address, the chain
  family is not supported, or there is no registry entry for the chain and
  symbol.

## Sources

- Circle Developer Docs, "USDC Contract Addresses": https://developers.circle.com/stablecoins/usdc-contract-addresses
