# Changelog

Versions track what ships, code or docs.

## Unreleased

### Changed

- The MCP server pins the owner's policy file when it starts. If the file's bytes differ on a later call, `consult` answers `UNKNOWN` with `ADAPTER_POLICY_CHANGED`; restart the server to accept a new policy. A file that is deleted or unreadable still answers `ADAPTER_POLICY_UNREADABLE`.

## [0.4.1] - 2026-09-30

The code in `@hedwig/consult` and `@hedwig/mcp` is identical to v0.4.0. Only the MCP server README changed in the packages.

### Added

- The usehedwig.xyz site source, under `web/`. The root README links the live site, not the `web/` source. (#60, #61)

### Changed

- The root README's license badge changes color to match the site. (#60)
- The MCP server README lists the install steps a clean clone needs: `yarn install --frozen-lockfile` and `npm ci --ignore-scripts --prefix mcp`, before the build. (#62)
- The MCP server README asks for absolute paths in `args` and in `HEDWIG_POLICY_FILE`. A relative path resolves against the MCP client's working directory, not the repo. (#62)
- The MCP server README's response list names the `question` field. (#62)

## [0.4.0] - 2026-09-27

### Added

- The Trigger guard, `runTriggerGuard` in the new `@hedwig/consult/guard` subpath export. It runs `consult()` on the Caller's mapped request and calls the Caller's signer only when the Verdict is `ALLOW_UNDER_POLICY`. The Caller cannot pass in a Verdict of its own.
- The revoke demo records four outcomes from one server process: an allowed payment, an over-cap payment denied, a missing role Fact answered `UNKNOWN`, and the original payment denied after the role is revoked. (#58)

### Removed

- The honesty evals (`evals/`), the `honesty-evals.yml` workflow, and the `evals`, `evals:offline`, `evals:judge` and `evals:test` npm scripts. (#53)
- The `public:check` and `public:test` npm scripts, their CI steps, the pull request template, and the matching CONTRIBUTING section. (#54)
- The agent skill's generated data and offline evals (`augment/data`, `augment/evals`), the `augment:verify` script, its CI step, and `scripts/verify-augment.js`. (#55)

### Changed

- The agent skill's Condition reference names `describeCatalog()` in `@hedwig/consult/introspect` as the source of each Condition's `policyFields`. (#55)
- The demo app README installs the app with `npm ci --prefix app`, the same command CI runs. (#52)
- The demo's `--out` record names the post-revoke ask `ask4`, renamed from `ask2`, and records the run's `commit`, `treeClean`, `startedAt` and `finishedAt`. (#58)

### Fixed

- The PDA vector tests run under their own timeout. (#51)

## [0.3.0] - 2026-09-22

A new Floor Condition is a versioned change for every policy: a policy that omits the Condition's field answers `UNKNOWN` with a code naming the field, and a policy opts out with `{ "mode": "not-required" }`.

### Added

- `authorization-window-within-ceiling`, a `pay` Floor Condition comparing an EIP-3009 authorization's `validBefore` against the owner's `authorizationWindow` policy. (#48)
- `policyFields` on every catalog Condition, exposed by `describeCatalog()` and `augment/data/conditions.json`: the policy fields each checker reads, so a policy can be checked against the catalog before a call. (#48)
- The canonical asset table, generated data files and evals cover the new Condition; every existing policy example carries `authorizationWindow: { "mode": "not-required" }`. (#48)

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
