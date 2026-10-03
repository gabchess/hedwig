# Hedwig devnet membership demo

This demo shows how related Anchor programs can share one Hedwig role store
while each consumer still authenticates its own actor. It runs Hedwig's
six-instruction membership lifecycle through `@hedwig-sol/sdk`: create_org,
create_role, assign_role, check_role, set_role_enabled(false), and revoke_role.

The same app also proves that an authenticated Hedwig member can change state
in the separate devnet reference consumer through CPI.

## Prerequisites

- Node.js 22+
- A throwaway devnet keypair. Each demo creates one the first time it runs and
  prints its path and public key. The demos never read your Solana CLI wallet.
  `demo` uses `~/.hedwig/demo-keys/lifecycle-demo-admin.json`, `consumer-demo`
  uses `~/.hedwig/demo-keys/consumer-demo-payer.json`, and `revoke-demo` uses
  `~/.hedwig/demo-keys/revoke-demo-admin.json`.
- To use a different key, set `HEDWIG_DEMO_KEYPAIR` to an absolute path. An
  empty or relative value is refused, and so is any path inside a git work
  tree or under `~/.config/solana`, `~/secrets` or a `target/deploy`
  directory. The default applies only when the variable is unset.

Fund the demo key on devnet after its first run prints the public key:

```bash
solana airdrop 1 <the-printed-pubkey> --url devnet
```

Every demo asks the RPC endpoint for its genesis hash before it loads a key or
signs anything, and stops unless the answer is devnet's.

## Install

From the repository root, install the locked root dependencies and build the
SDK before resolving the app's local file dependency:

```bash
yarn install --frozen-lockfile
yarn sdk:build
```

Then install the app dependencies with the same command CI runs:

```bash
npm ci --prefix app
```

## Run

```bash
npm --prefix app run demo
```

The app's `predemo` hook rebuilds the SDK through the root `sdk:build` script
before each run. The locked root install is still required on a clean checkout.

By default the demo connects to the public devnet RPC
(`https://api.devnet.solana.com`), which rate-limits under load. To use a
dedicated RPC instead, set `HELIUS_RPC_URL` before running:

```bash
export HELIUS_RPC_URL="https://devnet.helius-rpc.com/?api-key=<your-key>"
npm --prefix app run demo
```

Never commit an API key. Pass it as an environment variable only. A URL that
answers with any other cluster's genesis hash is refused.

## What it does

An Org PDA is derived from the wallet, not from the random display name. Each
wallet can therefore run this demo once. Point `HEDWIG_DEMO_KEYPAIR` at a new
file and fund it for another run.

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
npm --prefix app run consumer-demo
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
no redeploy and no server restart. Between asks, the demo changes the
request amount, runs one ask on a second server started on a policy file
with a swapped role program id, and revokes the role on-chain.

```bash
yarn consult:build && yarn mcp:build && npm --prefix app run revoke-demo
```

It generates its own throwaway keypair the first time it runs (a file
outside the repository, overridable with `HEDWIG_DEMO_KEYPAIR`, printed
with whether it is the default or an explicit path), funds it
from the devnet faucet, creates an org and a role, assigns the role to a
second generated key, and spawns the built MCP server over stdio. It asks
four questions: an allow while the role is held, an over-cap payment that
must DENY, a payment missing a required Fact that must return UNKNOWN, and
the original request repeated after revoking the role on-chain. Asks 1, 2
and 4 go to the same running process. The server pins its policy file when
it starts, so a swap under a running server answers `ADAPTER_POLICY_CHANGED`.
Ask 3 therefore swaps the on-disk policy file, starts a second server on it,
asks, stops that server, and restores the original file before the revoke. It prints a transcript
with every transaction's signature and an explorer link, and all four
verdicts. Pass `--out <path>` to also write the full machine-readable
record of all four answers.

The RPC endpoint defaults to the public devnet RPC; set
`HEDWIG_DEMO_RPC_URL` to use a different one. The demo refuses to run
against any cluster whose genesis hash is not devnet's.

A recorded run of the original two-ask version is at
[`docs/deployment/evidence/2026-09-22-revoke-demo.md`](../docs/deployment/evidence/2026-09-22-revoke-demo.md).
A recorded run of the four-ask version is at
[`docs/deployment/evidence/2026-09-27-revoke-demo.md`](../docs/deployment/evidence/2026-09-27-revoke-demo.md).
