# Contributing to Hedwig

This repository contains Hedwig's payment and swap checks, MCP server and Solana role program. Keep changes narrow and match public claims to the code and its evidence.

## Local checks

Run the checks for the components your PR changes and their callers. For
documentation, verify examples and links against the relevant release or
branch. Use the full block below for a release or a change across components.
Install root dependencies with `yarn install --frozen-lockfile` first.

```bash
cargo fmt --check
cargo build
cargo build-sbf --manifest-path programs/hedwig_consumer/Cargo.toml
cargo build-sbf --manifest-path programs/hedwig_sol/Cargo.toml
cargo test --workspace
yarn sdk:typecheck
yarn sdk:test
yarn sdk:build
npm ci --prefix app
./node_modules/.bin/tsc -p app/tsconfig.json --noEmit
npm --prefix app test
yarn consult:typecheck
yarn consult:test
yarn consult:build
npm ci --ignore-scripts --prefix mcp
yarn mcp:typecheck
yarn mcp:build
yarn mcp:test
```

The Rust integration tests use LiteSVM. Test suites run offline; dependency
installation and audits need a network connection. Build both SBF artifacts
before the workspace tests because the fixtures load them at compile time.
CI runs the checks on every push and pull request, along with dependency audits.

## Repo map

- Payment check: `consult/`
- MCP server: `mcp/`
- Program source: `programs/hedwig_sol/src/`
- Program tests: `programs/hedwig_sol/tests/`
- Secure consumer and tests: `programs/hedwig_consumer/`
- Repository-local TypeScript SDK alpha: `sdk/`
- SDK-driven devnet demo: `app/demo.ts`
- Integration guide: `docs/access-control/integration-guide.md`
- Architecture map: `docs/access-control/architecture.md`
- Threat model and known risks: `THREAT-MODEL.md`

## Contribution rules

- Keep the core instruction set small: `create_org`, `create_role`, `assign_role`, `revoke_role`, `check_role`, and `set_role_enabled`.
- Do not add nested role hierarchies or agent-to-agent delegation to the core program. Build those patterns as wrapper programs.
- Do not treat `check_role` as identity authentication. A consuming program must authenticate the holder before trusting the role check.
- Preserve the conventional Anchor shell, but name domain code after Hedwig concepts and actions. Avoid generic `utils`, `manager`, or `service` layers.
- Add an abstraction only after a concrete integration demonstrates repeated need. Prefer deletion and direct code when both are equally safe.
- Keep unfinished work in docs or issues, not as TODO/FIXME stubs in source.
- Update README and threat-model claims together when a change affects shipped status, risks, or public guarantees.

## Pull request bar

A useful PR says what changed, why it matters, and which check proves it. If the
change touches authorization, include at least one negative test for the failure
path.
