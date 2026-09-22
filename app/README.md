# Hedwig devnet membership demo

This demo shows how related Anchor programs can share one Hedwig role store
while each consumer still authenticates its own actor. It runs Hedwig's
six-instruction membership lifecycle through `@hedwig-sol/sdk`: create_org,
create_role, assign_role, check_role, set_role_enabled(false), and revoke_role.

The same app also proves that an authenticated Hedwig member can change state
in the separate devnet reference consumer through CPI.

## Prerequisites

- Node.js 18+
- A funded devnet wallet at `~/.config/solana/id.json` (or set `ANCHOR_WALLET`
  to a different keypair path)
- `socket` installed (`npm install -g socket`) for the security-gated install

Fund a devnet wallet if needed:

```bash
solana airdrop 1 <your-pubkey> --url devnet
```

## Install

From the repository root, install the locked root dependencies and build the
SDK before resolving the app's local file dependency:

```bash
yarn install --frozen-lockfile
yarn sdk:build
```

Then install the app dependencies through Socket:

```bash
cd app
socket npm install
```

## Run

```bash
npm run demo
```

The app's `predemo` hook rebuilds the SDK through the root `sdk:build` script
before each run. The locked root install is still required on a clean checkout.

By default the demo connects to the public devnet RPC
(`https://api.devnet.solana.com`), which rate-limits under load. To use a
dedicated RPC instead, set `HELIUS_RPC_URL` before running:

```bash
export HELIUS_RPC_URL="https://devnet.helius-rpc.com/?api-key=<your-key>"
npm run demo
```

Never commit an API key. Pass it as an environment variable only.

## What it does

An Org PDA is derived from the wallet, not from the random display name. Each
wallet can therefore run this demo once. Use a fresh funded wallet for another
run.

The script prints one labeled line per instruction with the resulting
transaction signature, reads back the Role and Member account state after
`assign_role`, disables the Role, confirms the Member PDA closes after
`revoke_role`, and ends with `six-instruction lifecycle OK on devnet` on
success.

The generated holder does not sign. `check_role` proves that its pubkey has an
active membership; it does not authenticate control of that key.

## Run the live consumer proof

The consumer proof funds a fresh actor with 0.02 devnet SOL, makes that actor its
own org authority and role holder, initializes a counter owned by the reference
consumer, and increments it through Hedwig CPI:

```bash
npm run consumer-demo
```

It requires both live program IDs:

- Hedwig: `H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC`
- Consumer: `52D3pTYvMwLYbiigY5xg55n4HmtEzTKCEicx1Cojzo9a`

The command verifies the consumer account owner, Anchor discriminator, stored
authority, stored role, counter value, and matching Hedwig member holder. It
ends with `Hedwig-gated consumer state change OK on devnet`.

The first public run is recorded in
[`docs/deployment/evidence/2026-07-24-consumer-devnet-integration.md`](../docs/deployment/evidence/2026-07-24-consumer-devnet-integration.md).
It is a builder-owned reference integration, not independent adoption.

## Run the revoke demo

The revoke demo shows a policy requiring a Solana role change its answer with
no redeploy, no config edit and no server restart: only an on-chain revoke.

```bash
yarn consult:build && yarn mcp:build && npm --prefix app run revoke-demo
```

It generates its own throwaway keypair the first time it runs (a file
outside the repository, overridable with `HEDWIG_DEMO_KEYPAIR`), funds it
from the devnet faucet, creates an org and a role, assigns the role to a
second generated key, and spawns the built MCP server once over stdio. It
asks the server the same payment question twice: once while the role is
held, and once after revoking it on-chain, with no restart in between. It
prints a transcript with every transaction's signature and an explorer
link, and the two verdicts. Pass `--out <path>` to also write the full
machine-readable record of both answers.

The RPC endpoint defaults to the public devnet RPC; set
`HEDWIG_DEMO_RPC_URL` to use a different one. The demo refuses to run
against any cluster whose genesis hash is not devnet's.

A recorded run is at
[`docs/deployment/evidence/2026-09-22-revoke-demo.md`](../docs/deployment/evidence/2026-09-22-revoke-demo.md).
