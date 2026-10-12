# Hedwig

<p align="center">
  <img src="docs/logo.svg" alt="Hedwig mark" width="240" height="160">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8b5cf6?labelColor=0d0b16" alt="license: MIT"></a>
</p>

> If AI is making it easier to transact onchain, we need to make it dramatically safer for everyone to use it.

**Ask Hedwig before your agent pays.**

Hedwig checks your agent's payment against your rules and answers proceed or stop, with reasons. Hedwig never signs or sends.

## Try Hedwig now

Paste this line into your coding agent:

```
Help me install Hedwig. Open this exact link and follow its instructions: https://usehedwig.xyz/agents.md
```

The agent asks you before it installs anything. Then it adds a local MCP server named `hedwig` and calls its `consult` tool before it signs a payment or swap. It goes ahead only when `proceed` is `true`. A request Hedwig can't check comes back `UNKNOWN` with `proceed: false`.

You need Git, Node.js 22 or newer, and Yarn. The agent runs the install on your computer. To set Hedwig up by hand, follow [docs/agents.md](docs/agents.md).

## The story

I started Hedwig on 2026-06-12 as a roles program for Solana. An organization creates a role, assigns it to a wallet with an expiry, and can revoke it later. Other programs call `check_role` before they act.

## The first tests

The first release, tag `hedwig-sol-v1`, had the six-instruction Anchor program, a small consumer program that calls `check_role`, and a TypeScript SDK. The program runs on Solana devnet as `H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC`.

On 2026-09-27 I sent four payment asks to one Hedwig server on devnet:

1. A payment within the cap, from a wallet that held the role: allowed.
2. The same payment over the cap: `DENY`.
3. A policy that needs the role, with no role fact to read: `UNKNOWN`.
4. The first payment again, after I revoked the role onchain: `DENY`.

The [run record](docs/deployment/evidence/2026-09-27-revoke-demo.md) has every transaction. The program code is at [tag v0.4.2](https://github.com/gabchess/hedwig/tree/v0.4.2/programs).

## The pivot

I wanted an agent's payment checked against its owner's rules before it goes out, and a role is only one of those rules. On 2026-09-22 I renamed the repo from `hedwig-sol` to `hedwig`. The role check became one input to a check that runs before each payment.

[`@hedwig/consult`](consult/README.md) holds that check. For a payment it compares the recipient, token, amount and chain with your rules. Swaps also get slippage and deadline checks. The [MCP server](mcp/README.md) lets your agent call it. The install guide uses v0.4.2, released 2026-09-30.

## Build and test

```sh
yarn install --frozen-lockfile --ignore-scripts
npm ci --ignore-scripts --prefix mcp
yarn consult:build && yarn mcp:build && yarn consult:test && yarn mcp:test
```

[usehedwig.xyz](https://usehedwig.xyz) · [Security](SECURITY.md) · [License (MIT)](LICENSE)
