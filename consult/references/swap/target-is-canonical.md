# target-is-canonical (swap)

The router the transaction calls is checked against a fixed registry of
canonical router deployments, keyed by chain. The check flags a swap that
routes through a lookalike or unaudited contract instead of the chain's
real router, even when every other field looks correct.

- PASS: the target contract matches the registry's canonical router for
  the request's chain.
- FAIL: the target contract is well-formed but does not match the
  canonical router.
- UNVERIFIED: the target is missing or not a well-formed address, the
  chain family is not supported, or there is no registry entry for the
  chain.

## Sources

- Uniswap Developer Docs, "Contract Deployments": https://docs.uniswap.org/contracts/v3/reference/deployments
- Uniswap Universal Router deployment addresses: https://github.com/Uniswap/universal-router/blob/main/deploy-addresses/mainnet.json
