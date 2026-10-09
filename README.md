# Hedwig

<p align="center">
  <img src="docs/logo.svg" alt="Hedwig mark" width="240" height="160">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8b5cf6?labelColor=0d0b16" alt="license: MIT"></a>
</p>

**Check before your agent pays.**

Your agent can pick the wrong token or send money to a bad destination. Hedwig checks the proposed action before signing. Your wallet keeps control of the money.

[Add an eval gate to your payment agent.](https://usehedwig.xyz/agents) · [How it works](https://usehedwig.xyz/how-it-works)

## Try a local check

The [setup guide](docs/agents.md) installs Hedwig v0.4.2 as a local MCP tool. Set your payment rules and run the sample. Change the recipient or amount to see a different result. The sample sends no funds.

The local checker returns a decision with reasons. Your integration must require `proceed: true` before signing. Read the [supported checks and limits](consult/README.md) before using it with funds.

The optional [Trigger guard](consult/README.md#trigger-guard) wraps your signer and checks calls routed through it.

## Next: Solana

We're building Solana checks for native USDC and bad deposit destinations. Each action will get one score from 0 to 1. Ask for a short report to understand the original result.

This flow uses Jev by TypeSafe. The live PayBox workflow and hosted access are in development. The setup above installs the local checker.

## Documentation

[Local checker](consult/README.md) · [MCP server](mcp/README.md) · [Solana SDK](sdk/README.md) · [Evidence](docs/evidence.md) · [Build and test](CONTRIBUTING.md) · [Threat model](THREAT-MODEL.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Founder pitch](https://youtu.be/LpKqZql87vk)
