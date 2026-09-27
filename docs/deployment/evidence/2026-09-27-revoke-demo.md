# Revoke demo, devnet, 2026-09-27

The demo code was extended (see `app/revoke-demo.ts` and
`app/revoke-demo-lib.ts` on this branch) to ask four questions instead of
two against the same live role record: an allow, an over-cap payment that
must DENY, a payment missing a required Fact that must return UNKNOWN,
then a revoke and the original request denied. `app/revoke-demo-lib.ts`,
which builds the two new asks' policy and request fixtures and formats
the transcript, is unit tested in `app/revoke-demo-lib.test.ts`.
`app/revoke-demo.ts` itself, the script that wires those pieces to a live
devnet run, has no automated test; this document is its evidence. The two
new fixtures in `app/test/fixtures/consult-responses.json` (`overCapDeny`,
`missingFactUnknown`) were captured by calling the built `consult()`
function directly, offline, no devnet traffic.

Two attempts failed before any org, role, or consult call was made (see
below). A third attempt, against a funded key, completed all four asks.
That attempt ran commit `73f0f79`, before the restore fix landed in
`2c13cdc` and the symlink and mode-600 fix landed in `a7ea834`, between
2026-09-27T16:32:02Z and 16:32:22Z. No row below was fabricated or
backfilled; every failed attempt is kept as it happened.

## Command

```
npm --prefix app run revoke-demo -- --out <path>
```

## Attempt 1 (wrong key, unfunded)

| Field | Value |
| --- | --- |
| UTC timestamp | 2026-09-27T16:22:11Z (approximate, first console line) |
| Faucet public key | `7MkrKU2arsCwqfeKeuAHbLjV2XYDYuF2G99p2kKH4b1w` |
| Failure | `airdrop failed: Internal error` |
| Exit code | 1 |

## Attempt 2 (wrong key)

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

## Root cause of attempts 1 and 2

`shouldRequestAirdrop` only fires below a 0.05 SOL balance. Both attempts
ran with `HEDWIG_DEMO_KEYPAIR` unset, so the demo fell back to the default
path (`~/.hedwig/demo-keys/revoke-demo-admin.json`), a key that had never
been funded, rather than an already-funded throwaway admin kept outside
the repository tree (admin `Fq2NR6KBqKGUeJUR8qtY65SawLZFs1ZgnnXH27FQRWQj`,
the same admin the 2026-09-22 run used). Pointing `HEDWIG_DEMO_KEYPAIR` at
that key's path put the balance above the floor, so no airdrop fired.

## Attempt 3 (funded key)

```
HEDWIG_DEMO_KEYPAIR=<path to the funded throwaway admin keypair> \
  npm --prefix app run revoke-demo -- --out <path>
```

The first run of attempt 3 failed at Ask 1 itself: the Solana role Reader's
own simulate call missed its 800 ms deadline against the public devnet
RPC, so `consult()` correctly answered UNKNOWN with `ROLE_FACT_MISSING`
even though the role was genuinely held (exit code 1, `process.exit(1)`
from the failed assertion). The demo does not read the server's error
output, so the actual cause of the missed deadline is unknown; it is not
a defect in `consult()`, which answered correctly given what it saw. It
did reach the chain before failing:

| Step | Transaction | UTC time |
| --- | --- | --- |
| create_role | [`4hhwT3aq...`](https://explorer.solana.com/tx/4hhwT3aqEQFi6LEfTHM569WXjoRuFCgVp8ZTTPSq7uLnNe5mePfpPH1SuytoT137HphgMjARw3UZGLYpwQmzZFKn?cluster=devnet) | 2026-09-27T16:32:02Z |
| assign_role | [`5XtcKrxE...`](https://explorer.solana.com/tx/5XtcKrxE5iQ9qTLHmWxEYT2TMYhCM3NFZNx8JHTjAfyCnG6WXLhCMxXckDevW6gdrrqSyPE9XMPKXnwRfCp4nmGR?cluster=devnet) | 2026-09-27T16:32:03Z |

That run created and assigned role `6prPnzpxZkK5Xi1eMf8fYGKbjwBaQHiYZiFHj6gTquZd`,
which was never revoked; it stays assigned on devnet, to a throwaway
holder generated for that run alone. The demo was run again with a fresh
role name (the org is reused, roles are not). That run completed all four
asks.

| Field | Value |
| --- | --- |
| Admin | `Fq2NR6KBqKGUeJUR8qtY65SawLZFs1ZgnnXH27FQRWQj` |
| Org | `AFFoRYATGSsbXPvxWj9YPHhvpEbziykZHxttiKAuJods` (reused, no new create_org tx) |
| Role | `5LACWG7G1Afz94Mj3f8VMb7cEJehsd2xKPpZv43KkN8X` |
| Holder | `EMTHqBCpKUoL5Qpk26ShK3hRrmZozbtz2koRUFcA4L1` |

| Step | Transaction |
| --- | --- |
| create_role | [`DSg86TP7...`](https://explorer.solana.com/tx/DSg86TP7YFZFtTzvzggqevoJmHmWny53HtjCMB9hyUUF7T9q5duMNn2RQNxzCGYPENv1QEZwdwMdJgcEzxZLbcu?cluster=devnet) (blockTime 2026-09-27T16:32:19Z) |
| assign_role | [`6mwwokSP...`](https://explorer.solana.com/tx/6mwwokSP1Fx3sZ8ncy2iHXXPeSYbcUGH6epnYzRjjyNsLaSC8hGctVuGh4qLtiSFiK53J2PkpJnyNdmxga9Dtf7?cluster=devnet) (blockTime 2026-09-27T16:32:20Z) |
| revoke_role | [`YKFNVeYN...`](https://explorer.solana.com/tx/YKFNVeYNUeMA8xTgFK3Zx5gtPcKu5wG2ug3Xz2Z5TYz3tpufsgknVMiexS6C5DAocrXDXdMSKCmuAJQQgxQxc7J?cluster=devnet) (blockTime 2026-09-27T16:32:22Z) |

Asks 1 to 3 (below) ran between the `assign_role` and `revoke_role`
blockTimes above, so each is timestamped `~2026-09-27T16:32:21Z`
(bounded, not printed by the script itself). Ask 4 ran immediately after
`revoke_role`, `~2026-09-27T16:32:22Z`.

| Ask | UTC time | Verdict | Proceed | Reason codes | Tx |
| --- | --- | --- | --- | --- | --- |
| 1, allow | ~16:32:21Z | ALLOW_UNDER_POLICY | true | `ROLE_HELD`, `AMOUNT_WITHIN_CAP` | none (read-only consult) |
| 2, over-cap | ~16:32:21Z | DENY | false | `AMOUNT_EXCEEDS_CAP`, role still `ROLE_HELD` | none (read-only consult) |
| 3, missing-fact | ~16:32:21Z | UNKNOWN | false | `ROLE_FACT_MISSING` | none (read-only consult) |
| 4, after revoke | ~16:32:22Z | DENY | false | `ROLE_MEMBER_MISSING` | `revoke_role` above |

## How Ask 3's UNKNOWN is produced

Ask 3 uses the same running server, the same live role, and the same
payment request as Ask 1. Immediately before the call, the demo swaps the
on-disk policy file's `role.programId` from Hedwig's deployed program id
to Solana's System Program id (`11111111111111111111111111111111`), a
real, well-formed pubkey that is never Hedwig's. The Solana role Reader
(`mcp/src/readers/solana-role.ts`) refuses to resolve a cluster config for
a program id it does not recognise, so it makes no RPC call and produces
no `solanaRole` fact. `role-requirement-met` then answers `ROLE_FACT_MISSING`,
UNVERIFIED, and `consult()` folds that to UNKNOWN. The demo restores the
original policy immediately after the call, before `revoke_role`.

## Restore safety fix

If the process dies between the swap and the restore, the on-disk policy
is left modified. Originally, always: the restore was a line after the
assertion, not a guaranteed step, so a thrown assertion (a bad verdict, a
dead server) would skip it. Fixed in `2c13cdc` by `withSwappedPolicyFile`
in `app/revoke-demo-lib.ts`: a thrown action error is now caught, the
restore write runs, and only then is the error re-thrown. This is a
catch block, not a `finally`, because a `finally` cannot tell a restore
failure from a restore success; the catch here can, and when the restore
write itself also fails, it throws an AggregateError carrying both the
action's error and the restore's, rather than losing one silently. This
still has limits a signal can reach. SIGINT and SIGTERM run the demo's
own handler, which deletes the whole temp directory instead of
restoring, so the swapped file does not survive either signal. SIGKILL
cannot be caught by any handler, so it always skips the restore. The demo
installs no SIGHUP handler either, so a SIGHUP can leave the swapped,
unrecognised-programId file sitting in an orphaned temp directory the
same way. The directory is mode 0700 and holds only the temporary
policy.json, itself made of public program/role/holder identifiers and
non-secret policy fields, no private key material, and a server reading
it answers UNKNOWN, so there is no security impact. The catch-and-restore
does not cover every exit path and this file does not claim that it does.

A separate fix, landed in `a7ea834`, closes a symlink gap: the swap and
restore writes now open the policy path with `O_NOFOLLOW`, which refuses
a policy path whose final path component is itself a symlink (it does
not check symlinked ancestor directories or stop a hardlink to a file
outside the demo's temp directory), and force file mode 600 on every
write rather than relying on `open`'s create-only mode argument. Six
tests in `app/revoke-demo-lib.test.ts` cover this: restore after a normal
return, restore after a throw, refusal of a symlinked policy path with a
message naming the symlink, mode 600 enforced even over a looser
pre-existing mode, a real open error (missing file) reported as itself
rather than as a symlink refusal, and both the action's and the
restore's errors surfacing together when a restore write also fails.

## Verification

- `npx tsc --noEmit -p app/tsconfig.json` passes.
- `npm test --prefix app` passes, 68/68.
- `yarn mcp:typecheck`, `yarn mcp:build` pass. `yarn mcp:test` passes,
  165 passing, 3 pending (the opt-in live-devnet tests).
