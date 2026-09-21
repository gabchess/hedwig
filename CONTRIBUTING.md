# Contributing to Hedwig

Hedwig is the onchain role program in this repository. Keep changes narrow, auditable, and honest about what is built versus planned.

## Local checks

Run the full local release checks before opening a PR:

```bash
cargo fmt --check
cargo build
cargo build-sbf --manifest-path programs/hedwig_consumer/Cargo.toml
cargo build-sbf --manifest-path programs/hedwig_sol/Cargo.toml
cargo test --workspace
yarn sdk:typecheck
yarn sdk:test
yarn sdk:build
./node_modules/.bin/tsc -p app/tsconfig.json --noEmit
```

The tests use LiteSVM and do not require a network connection. Build both SBF
artifacts before the workspace tests because the fixtures load them at compile
time. CI enforces the Rust, SBF, and app dependency-audit gates. The SDK and app
TypeScript checks remain required local gates until the repository's Yarn
install policy is resolved.

## Repo map

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

## Public repository boundary

Keep this repository useful to an external reader. Product behavior,
integration guidance, security and deployment evidence, and grant delivery
records belong here.

Keep private operating instructions, assistant configuration, planning
workflows, approval records, prospect work, and unpublished review provenance
outside this repository. Every proper name, link, and status claim must make
sense without access to a maintainer's local environment. Public grant,
adoption, deployment, and security claims must link to public evidence.

Run `yarn public:check` before opening a pull request. The check reads an optional list of extra patterns from the git info directory; without that file, run `PUBLIC_BOUNDARY_PRIVATE_PATTERNS_FILE= yarn public:check`.

## Pull request bar

A useful PR says what changed, why it matters, and which check proves it. If the
change touches authorization, include at least one negative test for the failure
path. Confirm that the public repository boundary still holds.
