# Hedwig

<p align="center">
  <img src="docs/logo.svg" alt="Hedwig mark" width="240" height="160">
</p>

<p align="center"><strong>The safety trigger onchain agents check before they pay.</strong></p>

<p align="center">
  <a href="#what-exists-today"><img src="https://img.shields.io/badge/status-MVP%20in%20progress-d4a574?labelColor=221e18" alt="status: MVP in progress"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-d4a574?labelColor=221e18" alt="license: MIT"></a>
</p>

## What Hedwig is

You tell your agent to check with Hedwig before it moves your money. The agent asks, Hedwig answers with what it can back up, and you see the reasoning. When the answer says stop, your agent is told to stop and to tell you why.

Hedwig is an augment. It is an expert on payment security, DeFi security and opsec that other agents consult, installed as a plugin or run as an MCP server inside whatever app you already hand work to. The goal is to make DeFi and autonomous onchain payments a better place for agents, x402 and agentic finance. Every chain is in scope: Ethereum, Solana, Monad and others.

## How your agent uses it

Planned. Nothing in this section runs yet.

The first ask comes from you, in your own words, and the agent carries it to Hedwig.

```text
You       Pay this invoice, but check with Hedwig first.

Agent     Hedwig, may I call this contract to send the payment?

Hedwig    DENY
          The role your owner granted you expired.
          Do not sign.


You       Put my idle USDC in this vault.

Agent     Hedwig, what do you know about this vault contract?

Hedwig    UNKNOWN
          I have no record of this address, so I cannot tell you
          it is the contract you meant.
          Checked: registry lookup, role lookup. Neither matched.


You       Go ahead with the swap.

Agent     Hedwig, may I call this router under our policy?

Hedwig    ALLOW_UNDER_POLICY
          Your role covers this target and has not expired.
          One key can still upgrade this contract and change what
          it does after you sign. That key is listed in the record.
```

The three verdicts are `ALLOW_UNDER_POLICY`, `DENY` and `UNKNOWN`. Hedwig fails closed: a missing record, a stale record, an RPC error or any mismatch returns `UNKNOWN`. Wording above is illustrative and the answers carry typed evidence rather than free text.

## What exists today

| Layer | What it is | State |
|---|---|---|
| Augment | The installable package: a front-door skill, capability skills added one at a time, and the knowledge base of markdown references on payment security, DeFi security and opsec. | Planned, first in the MVP |
| Checks | Deterministic checks the augment exposes over MCP and an API, returning `ALLOW_UNDER_POLICY`, `DENY` or `UNKNOWN`. | Planned, second in the MVP |
| Role record | Revocable onchain roles for agents, enforced by the program that reads them. | Shipped, Solana devnet |
| Opsec model | An open-source model adapted with retrieval, fine-tuning and LoRA. Reads, explains and flags. It can move a verdict toward caution and can never produce an allow. | Later, after funding |

A skill is advice an agent can ignore. Enforcement comes from the checks and the role record.

The MVP uses no model.

Hedwig is built for people running x402 payment tools and agent wallets. No integration with any wallet, rail or agent product exists yet.

## The shipped piece: the role record

Give an agent a role with an expiry. An integrated program checks that role before a protected action. Revoking membership or disabling the role denies later actions that enforce the check.

This first onchain piece runs on Solana devnet. The crate `hedwig_sol` and the package `@hedwig-sol/sdk` keep the names they had when this repository was called hedwig-sol, because the deployed devnet evidence is bound to them.

The program exports `create_org`, `create_role`, `assign_role`, `revoke_role`, `check_role` and `set_role_enabled`. The [architecture guide](docs/access-control/architecture.md) describes the account model.

### Integrating with `check_role`

Your program must authenticate the actor and bind the supplied role to its configured required role before calling `check_role`. Membership alone does not prove that the caller controls the holder account.

The check returns success or a Hedwig error. Propagate that error to stop the protected action. The [integration guide](docs/access-control/integration-guide.md) includes the compiling CPI consumer, negative tests and SDK flow.

Revocation applies through updated chain state. Transactions ordered before it can still succeed. It cannot undo transactions, terminate an agent process or block programs that skip the check.

### Evidence and open gates

The core and reference consumer have devnet deployment evidence. The repository records 41 Rust integration tests and 27 SDK tests. See the [promotion record](docs/deployment/evidence/2026-07-24-devnet-promotion.md), [consumer integration](docs/deployment/evidence/2026-07-24-consumer-devnet-integration.md) and [September presence check](docs/deployment/evidence/2026-09-06-program-presence.md).

Upgrade authority remains a single deployer key. An external security review and a multisig transfer remain open gates before mainnet. Read the [threat model](THREAT-MODEL.md) before integrating.

No signed pilot, design partner, customer, revenue, production use, or external adoption has been verified.

## Run the shipped piece locally

Requires Rust, Anchor CLI 1.0.2, Solana/Agave CLI 4.0.1+, Node.js 22+ and Yarn.

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

Build both SBF artifacts before the workspace tests. The tests run locally without a network connection. The [app guide](app/README.md) covers running the lifecycle on devnet.

[Build plan](https://github.com/gabchess/hedwig/milestone/1) · [Glossary](CONTEXT.md) · [Roadmap](ROADMAP.md) · [SDK](sdk/README.md) · [Threat model](THREAT-MODEL.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
