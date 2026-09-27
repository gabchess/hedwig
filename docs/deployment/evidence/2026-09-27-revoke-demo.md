# Revoke demo, devnet, 2026-09-27

## What ran

| Field | Value |
| --- | --- |
| Command | `HEDWIG_DEMO_KEYPAIR=<path> npm --prefix app run revoke-demo -- --out <path>` |
| Commit | `73f0f79` (branch head from 16:28:16Z; the next commit, `2c13cdc`, is 16:34:58Z) |
| UTC window | 2026-09-27T16:32:19Z to 16:32:22Z (create_role to revoke_role blockTimes) |
| Network | Solana devnet, `api.devnet.solana.com` |
| Program id | `H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC` |
| MCP server pid | 16652, all four asks |
| Admin | `Fq2NR6KBqKGUeJUR8qtY65SawLZFs1ZgnnXH27FQRWQj` |
| Org | `AFFoRYATGSsbXPvxWj9YPHhvpEbziykZHxttiKAuJods` (reused, no create_org tx) |
| Role | `5LACWG7G1Afz94Mj3f8VMb7cEJehsd2xKPpZv43KkN8X` |
| Holder | `EMTHqBCpKUoL5Qpk26ShK3hRrmZozbtz2koRUFcA4L1` |

| Step | Transaction |
| --- | --- |
| create_role | [`DSg86TP7...`](https://explorer.solana.com/tx/DSg86TP7YFZFtTzvzggqevoJmHmWny53HtjCMB9hyUUF7T9q5duMNn2RQNxzCGYPENv1QEZwdwMdJgcEzxZLbcu?cluster=devnet) |
| assign_role | [`6mwwokSP...`](https://explorer.solana.com/tx/6mwwokSP1Fx3sZ8ncy2iHXXPeSYbcUGH6epnYzRjjyNsLaSC8hGctVuGh4qLtiSFiK53J2PkpJnyNdmxga9Dtf7?cluster=devnet) |
| revoke_role | [`YKFNVeYN...`](https://explorer.solana.com/tx/YKFNVeYNUeMA8xTgFK3Zx5gtPcKu5wG2ug3Xz2Z5TYz3tpufsgknVMiexS6C5DAocrXDXdMSKCmuAJQQgxQxc7J?cluster=devnet) |

## Outcomes

| Ask | Verdict | Proceed | Reason codes | Tx |
| --- | --- | --- | --- | --- |
| 1, allow | ALLOW_UNDER_POLICY | true | `ROLE_HELD`, `AMOUNT_WITHIN_CAP` | none |
| 2, over-cap | DENY | false | `AMOUNT_EXCEEDS_CAP`, `ROLE_HELD` | none |
| 3, missing Fact | UNKNOWN | false | `ROLE_FACT_MISSING`, `AMOUNT_WITHIN_CAP` | none |
| 4, after revoke | DENY | false | `ROLE_MEMBER_MISSING`, `AMOUNT_WITHIN_CAP` | [`YKFNVeYN...`](https://explorer.solana.com/tx/YKFNVeYNUeMA8xTgFK3Zx5gtPcKu5wG2ug3Xz2Z5TYz3tpufsgknVMiexS6C5DAocrXDXdMSKCmuAJQQgxQxc7J?cluster=devnet) (revoke_role) |

Ask 3 ran with the policy file's `role.programId` set to
`11111111111111111111111111111111`. The demo wrote the original policy
back before revoke_role.

## Failed attempts

| UTC time | What failed | Tx left on chain |
| --- | --- | --- |
| ~16:22:11Z | `airdrop failed: Internal error`, exit 1 | none |
| ~16:24:02Z | airdrop HTTP 429 (faucet text below), exit 1 | none |
| 16:32:02Z | Ask 1 returned UNKNOWN with `ROLE_FACT_MISSING`, exit 1 (cause not captured) | create_role [`4hhwT3aq...`](https://explorer.solana.com/tx/4hhwT3aqEQFi6LEfTHM569WXjoRuFCgVp8ZTTPSq7uLnNe5mePfpPH1SuytoT137HphgMjARw3UZGLYpwQmzZFKn?cluster=devnet), assign_role [`5XtcKrxE...`](https://explorer.solana.com/tx/5XtcKrxE5iQ9qTLHmWxEYT2TMYhCM3NFZNx8JHTjAfyCnG6WXLhCMxXckDevW6gdrrqSyPE9XMPKXnwRfCp4nmGR?cluster=devnet) |

Faucet text for the HTTP 429: `You've either reached your airdrop limit
today or the airdrop faucet has run dry. Please visit
https://faucet.solana.com for alternate sources of test SOL.`

The first two attempts ran with `HEDWIG_DEMO_KEYPAIR` unset and asked the
faucet to fund `7MkrKU2arsCwqfeKeuAHbLjV2XYDYuF2G99p2kKH4b1w`. The third
left role `6prPnzpxZkK5Xi1eMf8fYGKbjwBaQHiYZiFHj6gTquZd` assigned on
devnet.

## Reproduce

```bash
yarn consult:build && yarn mcp:build
HEDWIG_DEMO_KEYPAIR=<path to a devnet keypair outside the repository> \
  npm --prefix app run revoke-demo -- --out <path>
```

Without `HEDWIG_DEMO_KEYPAIR`, the demo uses
`~/.hedwig/demo-keys/revoke-demo-admin.json`, generating it if missing, and
requests a faucet airdrop when its balance is below 0.05 SOL.
