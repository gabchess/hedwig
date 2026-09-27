# Revoke demo, devnet, 2026-09-27 (blocked, run 3 of 3)

This is the third of three planned revoke-demo runs. The demo code was
extended first (see `app/revoke-demo.ts` and `app/revoke-demo-lib.ts` on
this branch) to ask four questions instead of two against the same live
role record: an allow, an over-cap payment that must DENY, a payment
missing a required Fact that must return UNKNOWN, then a revoke and the
original request denied. The extended flow, and its two new asks, are
covered by `app/revoke-demo-lib.test.ts` and by two fixtures in
`app/test/fixtures/consult-responses.json` (`overCapDeny`,
`missingFactUnknown`), both captured by calling the built `consult()`
function directly, offline, no devnet traffic.

The devnet run itself could not complete. Both attempts failed at the
airdrop step, before any org, role, or consult call was made. No verdict
rows exist for this date: none were fabricated or backfilled.

## Command

```
npm --prefix app run revoke-demo -- --out <path>
```

## Attempt 1

| Field | Value |
| --- | --- |
| UTC timestamp | 2026-09-27T16:22:11Z (approximate, first console line) |
| Faucet public key | `7MkrKU2arsCwqfeKeuAHbLjV2XYDYuF2G99p2kKH4b1w` |
| Failure | `airdrop failed: Internal error` |
| Exit code | 1 |

## Attempt 2 (the one retry)

| Field | Value |
| --- | --- |
| UTC timestamp | 2026-09-27T16:24:02Z (approximate, first console line) |
| Faucet public key | `7MkrKU2arsCwqfeKeuAHbLjV2XYDYuF2G99p2kKH4b1w` |
| Failure | HTTP 429, faucet limit reached or dry |
| Exit code | 1 |

Both exit codes come from `revoke-demo.ts`'s own airdrop failure branch
(`process.exit(1)`), not from an uncaught crash. The full faucet response
for attempt 2: `You've either reached your airdrop limit today or the
airdrop faucet has run dry. Please visit https://faucet.solana.com for
alternate sources of test SOL.`

## Why the airdrop ran at all

`shouldRequestAirdrop` only fires below a 0.05 SOL balance. The demo's
throwaway admin key (`~/.hedwig/demo-keys/revoke-demo-admin.json`, reused
by design across runs since the org PDA it derives can only be created
once per key) had fallen under that floor, most likely from the rent and
fees spent by the two earlier revoke-demo runs plus a growing devnet fee
market. The public devnet faucet (`api.devnet.solana.com`) was rate
limited or dry at the time of both attempts.

## What this means for the four-outcome extension

The extension itself is done and independently verified offline:

- `npx tsc --noEmit -p app/tsconfig.json` passes.
- `npm test --prefix app` passes, 57/57, including the six new tests for
  the over-cap and missing-fact asks.
- `yarn mcp:typecheck`, `yarn mcp:build`, `yarn mcp:test` all pass, 165/165.

A live devnet recording of the four-outcome flow still needs a funded
throwaway key or a working faucet, and is not part of this record. No ask,
transaction, or verdict from this attempted run is claimed above; this
file exists to state the blocker precisely rather than skip recording it.
