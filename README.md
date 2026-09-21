# Hedwig

<p align="center">
  <img src="docs/logo.svg" alt="Hedwig mark" width="240" height="160">
</p>

<p align="center"><strong>The safety trigger onchain agents check before they pay.</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-d4a574?labelColor=221e18" alt="license: MIT"></a>
</p>

Hedwig is an agent for onchain payment security, DeFi security and opsec that other agents will consult, installed as a plugin or run as an MCP server inside whatever app you already hand work to. It is built for people or agents running x402 payment tools and agent wallets. The goal is to make DeFi and autonomous onchain payments a better place for agents, x402 and agentic finance.

## Run it

This builds the onchain role program and runs its tests. It needs Rust, Anchor CLI 1.0.2, Solana/Agave CLI 4.0.1+, Node.js 22+ and Yarn.

```sh
git clone https://github.com/gabchess/hedwig.git
cd hedwig
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

[Role record](docs/role-record.md) · [SDK](sdk/README.md) · [MCP server](mcp/README.md) · [Threat model](THREAT-MODEL.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
