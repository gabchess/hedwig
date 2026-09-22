# Hedwig

<p align="center">
  <img src="docs/logo.svg" alt="Hedwig mark" width="240" height="160">
</p>

<p align="center"><strong>The safety trigger onchain agents check before they pay.</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-d4a574?labelColor=221e18" alt="license: MIT"></a>
</p>

Hedwig is the payment check other agents consult before they sign. Run it as an MCP server, or load the agent skill in whatever app you already hand work to. It is built for people or agents running x402 payment tools and agent wallets.

## Run it

The payment check has no dependencies of its own; it needs Node.js 22+ and Yarn. It answers `proceed` for a payment or a swap against the owner's policy. Any check it cannot complete answers `UNKNOWN`, and `proceed` stays `false`:

```sh
git clone https://github.com/gabchess/hedwig.git
cd hedwig
yarn install
yarn consult:typecheck
yarn consult:test
```

The onchain role program builds and tests with Rust, Anchor CLI 1.0.2, Solana/Agave CLI 4.0.1+, Node.js 22+ and Yarn.

```sh
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

[Payment check](consult/README.md) · [MCP server](mcp/README.md) · [Agent skill](augment/README.md) · [Role record](docs/role-record.md) · [SDK](sdk/README.md) · [Threat model](THREAT-MODEL.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
