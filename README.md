# Hedwig

<p align="center">
  <img src="docs/logo.svg" alt="Hedwig mark" width="240" height="160">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8b5cf6?labelColor=0d0b16" alt="license: MIT"></a>
</p>

**Check before your agent pays.**

Hedwig checks a payment agent's proposed action against the owner's rules and available evidence, then returns a result with reasons. Your wallet or app controls signing and execution.

[Add an eval gate to your payment agent](https://usehedwig.xyz/agents) · [See the recorded checks](https://usehedwig.xyz/proof) · [Read the evidence](docs/evidence.md)

The [setup guide](docs/agents.md) installs the local v0.4.2 checker. Component guides label later changes on `main`. The Solana-mainnet PayBox flow, transaction score and original report are in development.

## Run a local check

Set your policy and run the sample payment check. Change the recipient to see how the result changes. The sample sends no funds.

The [local checker](consult/README.md) returns `ALLOW_UNDER_POLICY`, `DENY` or `UNKNOWN`, with reasons and missing evidence. Its `support` value measures evidence coverage, not safety probability.

The optional [Trigger guard](consult/README.md#trigger-guard) calls your signer only after an allowed result. It covers calls routed through it. An allow applies to the stated policy and checks; see the component guide for supported checks and limits.

## In development

You ask your agent to swap SOL into native USDC, then deposit it into a vault. The Solana demo we are building checks each prepared transaction before signing: let a swap that passes the checks proceed and hold a controlled invalid vault proposal. Ask for the saved assessment when you want the reason.

The planned flow uses Jev by TypeSafe with current chain facts and relevant DeFi knowledge. It returns one score from 0 to 1 for each assessment. An allowed result applies to the configured checks; it cannot guarantee an investment outcome. The original report explains that assessment without scoring it again.

A complete live PayBox flow and hosted MCP access still need qualification. Ethereum, Monad and Tempo have separate adapter and evidence requirements. The current local checker and recorded Solana devnet checks are linked above.

## Documentation

[Local checker](consult/README.md) · [MCP server](mcp/README.md) · [Solana SDK](sdk/README.md) · [Evidence](docs/evidence.md) · [Build and test](CONTRIBUTING.md) · [Threat model](THREAT-MODEL.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Founder pitch](https://youtu.be/LpKqZql87vk)
