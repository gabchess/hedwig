# Hedwig

<p align="center">
  <img src="docs/logo.svg" alt="Hedwig mark" width="240" height="160">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8b5cf6?labelColor=0d0b16" alt="license: MIT"></a>
</p>

Hedwig is built to help agents and humans check an onchain payment before they sign.

Your payment agent sends a proposal. Hedwig checks it against your rules and available evidence, then returns a result with reasons. The caller controls signing and execution.

[Try Hedwig locally](https://usehedwig.xyz/agents): paste the setup prompt into your coding agent. The [agent guide](docs/agents.md) installs v0.4.2; component guides label later changes on `main`.

## Local checks

The [local checker](consult/README.md) uses deterministic rules to return `ALLOW_UNDER_POLICY`, `DENY` or `UNKNOWN`, with reasons and missing evidence. Payment and swap references cover Ethereum and Base. Its `support` value measures evidence coverage, not safety probability.

Your payment agent controls signing and execution. The [trigger guard](consult/README.md#trigger-guard) covers calls routed through it. An allow applies only to the stated checks and policy. Slippage checks use supplied quotes; fresh quotes and sandwich detection remain unsupported.

See the [MCP server](mcp/README.md), [Solana SDK](sdk/README.md) and [recorded devnet proof](docs/deployment/evidence/2026-09-27-revoke-demo.md) for component details.

## Planned

Hosted assessment, human chat and a Monad swap demo are in development. A scoring model will assess blockchain evidence and curated knowledge in DeFi, onchain payments, security and opsec. A separate API-backed language model will explain the result without changing it or executing transactions.

After funding, we plan to train and evaluate an open explanation model on permitted data, with cloud GPUs for training and hosting, and add private assessment histories.

## Documentation

[Build and test](CONTRIBUTING.md) · [Founder pitch](https://youtu.be/LpKqZql87vk) · [Evidence](docs/evidence.md) · [Threat model](THREAT-MODEL.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
