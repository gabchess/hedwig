# Changelog

Versions track shipped code.

## Unreleased

### Added

- `authorization-window-within-ceiling`, a `pay` Floor Condition comparing an EIP-3009 authorization's `validBefore` against the owner's `authorizationWindow` policy. `policyFields` on every catalog Condition names which Policy fields its checker reads.

## [0.2.0] - 2026-09-22

Tests on the verdict path mutate one field at a time and pin the resulting verdict. The agent skill's checker proves itself against a mutated data file, a dropped reference and a flipped eval verdict.

### Added

- `@hedwig/consult`, a payment check with no dependencies of its own. `consult(request, policy, facts)` answers `proceed`, a verdict (`ALLOW_UNDER_POLICY`, `DENY`, `UNKNOWN`), a `support` score from 0 to 1, a band, and one row per Condition carrying a fixed question, a reason code, an evidence class and a reference file. (#30, #31, #33)
- The `pay` action's mandatory checks: the recipient matches an entry the owner approved, the recipient has no recorded poison transfer, the asset contract is canonical, the amount is above zero and within the owner's cap, the chain matches the owner's named chain, and the transaction calls the canonical asset contract. (#30, #33)
- The `swap` action: the router is canonical, both token contracts are canonical, declared slippage is compared exactly against the owner's ceiling, the deadline is set and still fresh, the output recipient is the owner, and the approval covers exactly this swap's input amount. (#34)
- `role-requirement-met`, a Solana role requirement stated in the owner's policy and answered from a supplied fact, on both `pay` and `swap`. (#35)
- `@hedwig/mcp`, a stdio MCP server with one tool, `consult`, reading the owner's policy from a file named in the environment. (#32, #40)
- A Solana role reader in the server. It simulates `check_role` with no key and hands the result to the check as a fact. (#38)
- Canonical USDC and WETH entries for Base. (#42)
- `augment/`, the agent skill: a front door, four reference files, data generated from the Condition catalog, eight offline evals and a checker that runs in CI. (#43, #44)
- A recorded devnet run: a role assigned, a payment allowed, the role revoked on-chain, the next payment denied, one server process throughout, with its evidence file. (#41)

### Changed

- The repository is `hedwig`, renamed from `hedwig-sol`. Old URLs redirect. The README and docs describe the payment check. (#26, #29, #37)
- The grant ledger records delivery as dated history. (#39)

### Fixed

- The public-boundary check fails when its patterns file is missing. (#36)

## hedwig-sol-v1

The six-instruction Anchor program, the reference consumer and the TypeScript SDK `0.1.0-alpha.0`.
