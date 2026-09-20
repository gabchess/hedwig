# Changelog

Versions track shipped code. A change in direction with no new code stays under Unreleased.

## Unreleased

### Changed

- The repository was renamed from `hedwig-sol` to `hedwig`. Old URLs redirect.
- README and ROADMAP now describe Hedwig as the safety trigger onchain agents check before they pay, on any chain. The augment, the checks and the opsec model are planned. Nothing in them is built.
- The role record stays in place as the one shipped piece. The crate `hedwig_sol`, both program IDs and the package `@hedwig-sol/sdk` keep their names.

### Added

- `CONTEXT.md`, the glossary.
- `augment/README.md` and `consult/README.md`, where the planned work starts.
- An honesty eval case that pins the planned wording.

### Before a 2.0.0 tag

The augment installs and its evals run. One deterministic check runs over MCP with test evidence. The threat model covers the checks.

## hedwig-sol-v1

Tagged on the last commit before the change of direction. Six-instruction Anchor program, reference consumer, TypeScript SDK `0.1.0-alpha.0` in the repository and not on npm, 41 Rust and 27 SDK tests, devnet only. See the release notes for limits. The full old tree is kept on `archive/hedwig-sol-2026-09-20`.
