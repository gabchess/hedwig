# Hedwig

<p align="center">
  <img src="docs/logo.svg" alt="Hedwig mark" width="240" height="160">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8b5cf6?labelColor=0d0b16" alt="license: MIT"></a>
</p>

Hedwig is built to help agents and humans check an onchain payment before they sign.

Hedwig checks a proposed payment or swap against your rules and available evidence, then returns a decision with reasons. Your wallet or app controls signing and execution.

[Try Hedwig](https://usehedwig.xyz/agents): give the setup prompt to a coding agent that supports local MCP tools. The [setup guide](docs/agents.md) installs v0.4.2; component guides label later changes on `main`.

## Run a local check

Set your policy and run the sample payment check. Change the recipient to see how the result changes. The sample sends no funds.

The [local checker](consult/README.md) returns `ALLOW_UNDER_POLICY`, `DENY` or `UNKNOWN`, with reasons and missing evidence. Its `support` value measures evidence coverage, not safety probability.

The optional [Trigger guard](consult/README.md#trigger-guard) calls your signer only after an allowed result. It covers calls routed through it. An allow applies to the stated policy and checks; see the component guide for supported checks and limits.

## In development

We are building an expert assessment service for payment agents and their users. The first planned workflows assess a Monad swap proposal and a Tempo token transfer, with Scout as the first caller. A fast scoring model will assess blockchain evidence and curated knowledge in DeFi, online security, blockchain security and onchain payments. The planned 0–1 score will come with reasons; a separate language model will explain the assessment on request and answer DeFi questions. Signing stays with the caller.

## Documentation

[Local checker](consult/README.md) · [MCP server](mcp/README.md) · [Solana SDK](sdk/README.md) · [Evidence](docs/evidence.md) · [Build and test](CONTRIBUTING.md) · [Threat model](THREAT-MODEL.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Founder pitch](https://youtu.be/LpKqZql87vk)
