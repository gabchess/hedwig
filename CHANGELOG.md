# Changelog

Versions track what ships, code or docs.

## Unreleased

### Changed

- The agent install, on `/docs`, in `agents.md` and in `docs/agents.md`, fetches the commit published as v0.4.2, which includes the policy pin.
- The roadmap lists v0.4.2 as the newest release. (#67)
- `/docs`, `agents.md` and `docs/agents.md` say that the server pins the policy file's bytes at start and answers `UNKNOWN` while the bytes differ. (#67)
- `agents.md` and `docs/agents.md` say that a deleted, unreadable or too-large policy file answers `ADAPTER_POLICY_UNREADABLE`, and that an agent stops and tells its owner on either pin code.
- `agents.md` and `docs/agents.md` tell an agent to report the first row whose status is not `PASS`. An `UNKNOWN` answer lists `PASS` rows first when every check passed and the policy does not permit.
- The agent docs no longer state the policy file's size cap. `mcp/README.md` still does.
- `docs/agents.md` says the Solana role read uses no private key.
- No sentence in `agentskill.md` or in the `agents.md` memory line ends on a URL.
- `mcp/README.md` and `THREAT-MODEL.md` give the size cap as 262,144 bytes, say that a directory or FIFO in the policy file's place answers `ADAPTER_POLICY_UNREADABLE`, and say that a server started while the file could not be read answers `UNKNOWN` on every call of that run.
- `/how-it-works` says a revoked role denies the next check on that payment.
- `/team` says USDG 1,500 of the USDG 3,000 grant has been received.
- The access-control architecture doc is titled "Role record program architecture".
- `/docs` says an `UNKNOWN` answer also covers a request where every check passed and the policy does not permit the action.
- The `mcp` and `consult` packages report version 0.4.2, matching the server.

### Fixed

- The 0.4.2 entry says the MCP server opens the policy file once. The server opens and reads the file on every call and compares its bytes to the hash taken at start.
- The grant progress doc gives the Rust test total as 43 (29 core integration, 12 consumer integration, two program-ID), matching `cargo test --workspace`.

## [0.4.2] - 2026-09-30

### Added

- The usehedwig.xyz pages `/agents` and `/docs`. `/agents` gives an owner one line to paste into an AI agent that can run commands on their computer. `/docs` covers connecting an agent, installing Hedwig yourself, the policy file, the request and response, and calling the check from your own code. (#65)
- `/agents.md`, `/agentskill.md` and `/llms.txt`, for AI agents. `agents.md` walks an agent through asking its owner, installing Hedwig and registering the server. `agentskill.md` says which payments to consult Hedwig on and how to offer it when it is not installed. `llms.txt` indexes the site. The three files are served with explicit `text/markdown` and `text/plain` content types. (#65)
- `docs/agents.md`, a reference for the `consult` request and response. (#65)
- A `Docs` and a `For agents` link in the nav of every site page. (#65)

### Changed

- The MCP server pins the owner's policy file when it starts. It hashes the file's bytes at start. Within one server run, if the bytes differ on a later call, `consult` answers `UNKNOWN` with `ADAPTER_POLICY_CHANGED` and the server writes one line to stderr naming `HEDWIG_POLICY_FILE`. The pin ends with the process: each server start pins whatever the file holds then, with no warning, so review the file before restarting, or keep it out of the agent's write reach. (#64)
- A policy file that is deleted, unreadable, not a regular file, or larger than 256 KB answers `UNKNOWN` with `ADAPTER_POLICY_UNREADABLE`. A file that could not be read at start stays refused for that run, even if it is fixed later. (#64)
- The MCP server opens the policy file once, without blocking, checks its type and size on that open descriptor, and reads at most 256 KB plus one byte from it. The extra byte shows that the file outgrew the cap. A swap of the path between the check and the read changes nothing. (#64)
- The revoke demo runs Ask 3, the missing-Fact case, on a second server process started on the swapped policy file, because a swap under a running server now answers `ADAPTER_POLICY_CHANGED`. Asks 1, 2 and 4 still share one process. (#64)
- `THREAT-MODEL.md`, the MCP server README and the demo README describe the pin. (#64)
- The roadmap lists v0.4.1 as the newest release. (#65)
- On desktop, the site frame is one screen tall and the panel scrolls. The phone layout is unchanged. (#65)
- The agent install on `/docs`, in `agents.md` and in `docs/agents.md` fetches the commit published as v0.4.1 by its full hash, into a new `hedwig` folder, and stops at the first failed step. That commit does not include the policy pin. (#65)
- The MCP server reports version 0.4.2 to clients. It reported 0.4.0 through v0.4.1.

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
