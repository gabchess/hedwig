# Hedwig

<p align="center">
  <img src="docs/logo.svg" alt="Hedwig mark" width="240" height="160">
</p>

<p align="center"><strong>An AI expert for payment agents and the people who use them.</strong></p>

<p align="center"><a href="https://usehedwig.xyz">usehedwig.xyz</a></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8b5cf6?labelColor=0d0b16" alt="license: MIT"></a>
</p>

Hedwig is being built to assess crypto payments and explain the risks. In the intended workflow, a payment agent automatically calls Hedwig through MCP while preparing a payment or swap. Hedwig checks the proposal against blockchain data and curated knowledge, then returns an assessment before the payment agent executes it. People will also be able to chat with Hedwig about DeFi, payments and blockchain security.

The hosted expert and chat are in development. This repository contains the working local payment and swap checker, MCP server, Trigger guard and Solana role program.

[Website](https://usehedwig.xyz) · [Founder pitch](https://youtu.be/LpKqZql87vk) · [Recorded devnet proof](docs/deployment/evidence/2026-09-27-revoke-demo.md) · [Install guide for agents](docs/agents.md)

## What you can run today

| Component | Current behavior |
| --- | --- |
| [Payment and swap check](consult/README.md) | Checks a supplied proposal against policy and available facts. Returns `ALLOW_UNDER_POLICY`, `DENY` or `UNKNOWN`, with reasons and missing evidence. |
| [Local MCP server](mcp/README.md) | Exposes the checker to agents through stdio. The owner controls the policy file. |
| [Trigger guard](consult/README.md#trigger-guard) | Calls the supplied signer only after an allow. Denied or unknown requests do not reach that signer through the guard. |
| [Solana role program and SDK](sdk/README.md) | Records scoped roles with expiry and revocation. The public demonstration uses Solana devnet. |

The current checker uses deterministic rules. Its `support` value, from 0 to 1, summarizes evidence coverage after the decision; it is not a probability that a transaction is safe. The caller supplies the proposal and can bypass the guard. An allow applies only to the checks and policy described in the answer.

Payment and swap references currently cover Ethereum and Base. Slippage checks compare the supplied quote and minimum output with the owner's limit. They do not fetch a fresh quote or detect sandwich attacks. Monad proof is still in development.

## Where Hedwig is going

The expert service will combine current chain data with private, curated knowledge in four areas: DeFi, onchain payments, security and operational security. A fast scoring model is planned to assess that evidence and produce an explanation agents and people can inspect.

Verified token and contract lookup, broader vault checks, sandwich-risk assessment and general chat are in development. Registry readers exist on `main`, but their signing keys are not configured, so live registry lookup remains inactive. The curated knowledge stays private while the core remains open source. Adapting an open model is a later research step using reviewed examples and consented data.

## Run the local prototype

Use Node.js 22+ and Yarn. These commands test the current development branch:

```sh
git clone https://github.com/gabchess/hedwig.git
cd hedwig
yarn install --frozen-lockfile
yarn consult:typecheck
yarn consult:test
```

For a pinned release and MCP setup, follow the [agent guide](docs/agents.md). It currently installs v0.4.2; later changes on `main` are labelled in the component guides. See [Contributing](CONTRIBUTING.md) for builds and checks by component, including the Solana toolchain.

## Documentation

[Role record](docs/role-record.md) · [Evidence](docs/evidence.md) · [Threat model](THREAT-MODEL.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
