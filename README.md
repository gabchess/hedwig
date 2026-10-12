# Hedwig

<p align="center">
  <img src="docs/logo.svg" alt="Hedwig mark" width="240" height="160">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8b5cf6?labelColor=0d0b16" alt="license: MIT"></a>
</p>

> If AI is making it easier to transact onchain, we need to make it dramatically safer for everyone to use it.

**Know before it pays.**

Hedwig is an eval gate that makes onchain payments safer. It checks the payment or swap your agent wants to make against curated knowledge bases before it pays. Built for the agent you already use.

## What it is

A second opinion you ask before your agent pays. Hedwig answers with its reasons, gives you a report when you ask, and you make the call. Hedwig never signs or sends.

## Who it is for

Anyone who lets an AI agent handle money, and the builders who connect agents to wallets.

## Why it matters

Agents move money faster than you can read the details. One wrong contract or amount costs real money. Hedwig puts the check at the moment that counts, before the payment.

## Try Hedwig today

Ask Hedwig before your agent pays. Paste this line into your coding agent, or open [usehedwig.xyz/agents](https://usehedwig.xyz/agents):

```
Help me install Hedwig. Open this exact link and follow its instructions: https://usehedwig.xyz/agents.md
```

Your agent asks you before it installs anything. It adds a local MCP server named `hedwig`. Before a payment or swap, the agent calls the `consult` tool and Hedwig answers with its reasons.

You need Git, Node.js 22 or newer, and Yarn. Your agent runs these commands:

```sh
mkdir hedwig && cd ./hedwig && git init &&
git fetch --depth 1 https://github.com/gabchess/hedwig.git e85049bc7087f434fd732bb02e0e87ca57acd82c &&
git checkout FETCH_HEAD &&
test "$(git rev-parse HEAD)" = e85049bc7087f434fd732bb02e0e87ca57acd82c &&
yarn install --frozen-lockfile --ignore-scripts && npm ci --ignore-scripts --prefix mcp && yarn consult:build && yarn mcp:build
```

They fetch one release by its full commit hash and stop at the first failure. The [install guide](docs/agents.md) covers the limits file you write, how to register the server with your MCP client, and how the agent calls `consult`.

## The story

I started Hedwig on 12 June 2026 as a roles program for Solana. An organization creates a role, gives it to a wallet with an expiry, and can take it back later. Other programs call `check_role` before they act.

The first version was a six-instruction Anchor program, a small consumer program and a TypeScript SDK. The program runs on Solana devnet as `H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC`. Its [source](https://github.com/gabchess/hedwig/tree/v0.4.2/programs) is public.

Then agents started holding wallets. I wanted the person behind the agent to know what a payment would do before it went out. On 20 September 2026 I renamed the repo from `hedwig-sol` to `hedwig`. A wallet's role became one of several things Hedwig looks at before a payment. [`@hedwig/consult`](consult/README.md) holds that logic, and the [MCP server](mcp/README.md) lets an agent call it.

On 27 September 2026 I sent four payment asks to one Hedwig server on Solana devnet. The last came after I revoked the wallet's role onchain. The [run record](docs/deployment/evidence/2026-09-27-revoke-demo.md) lists every transaction.

## Build and test

```sh
yarn install --frozen-lockfile --ignore-scripts
npm ci --ignore-scripts --prefix mcp
yarn consult:build && yarn mcp:build && yarn consult:test && yarn mcp:test
```

[usehedwig.xyz](https://usehedwig.xyz) · [Security](SECURITY.md) · [License (MIT)](LICENSE)
