# Hedwig

<p align="center">
  <img src="docs/logo.svg" alt="Hedwig mark" width="240" height="160">
</p>

<p align="center"><strong>Shared, revocable roles for software agents on Solana.</strong></p>

<p align="center">
  <a href="#current-status"><img src="https://img.shields.io/badge/network-devnet-d4a574?labelColor=221e18" alt="network: devnet"></a>
  <a href="sdk/README.md"><img src="https://img.shields.io/badge/SDK-alpha-d4a574?labelColor=221e18" alt="SDK: alpha"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-d4a574?labelColor=221e18" alt="license: MIT"></a>
</p>

Give an agent a role with an expiry. An integrated program checks that role before a protected action. Revoking membership or disabling the role denies later actions that enforce the check.

Hedwig is a devnet-stage Anchor program with six instructions, a reference consumer and a repository-local TypeScript SDK. Mainnet is planned. The SDK is not published.

## Run locally

Requires Rust, Anchor CLI 1.0.2, Solana/Agave CLI 4.0.1+, Node.js 22+ and Yarn.

```sh
git clone https://github.com/gabchess/hedwig-sol.git
cd hedwig-sol
yarn install
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
```

Build both SBF artifacts before the workspace tests. The tests run locally without a network connection. The [app guide](app/README.md) covers running the lifecycle on devnet.

## Use it

Create an organization and a role, then assign that role to an agent. Set an expiry or revoke membership when access should end.

The program exports `create_org`, `create_role`, `assign_role`, `revoke_role`, `check_role` and `set_role_enabled`. The [architecture guide](docs/access-control/architecture.md) describes the account model.

### Integrating with `check_role`

Your program must authenticate the actor and bind the supplied role to its configured required role before calling `check_role`. Membership alone does not prove that the caller controls the holder account.

The check returns success or a Hedwig error. Propagate that error to stop the protected action. The [integration guide](docs/access-control/integration-guide.md) includes the compiling CPI consumer, negative tests and SDK flow.

Revocation applies through updated chain state. Transactions ordered before it can still succeed. It cannot undo transactions, terminate an agent process or block programs that skip the check.

## Current status

The core and reference consumer have devnet deployment evidence. The repository records 41 Rust integration tests and 27 SDK tests. See the [promotion record](docs/deployment/evidence/2026-07-24-devnet-promotion.md), [consumer integration](docs/deployment/evidence/2026-07-24-consumer-devnet-integration.md) and [September presence check](docs/deployment/evidence/2026-09-06-program-presence.md).

Upgrade authority remains a single deployer key. An external security review and a multisig transfer remain open gates before mainnet. Read the [threat model](THREAT-MODEL.md) before integrating.

No signed pilot, design partner, customer, revenue, production use, or external adoption has been verified.

[Integration proof](docs/agent-access/integration-proof.md) · [SDK](sdk/README.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
