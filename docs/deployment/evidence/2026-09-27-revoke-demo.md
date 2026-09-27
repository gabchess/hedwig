# Revoke demo, devnet, 2026-09-27

Every value below is copied from this run's `--out` record,
[`2026-09-27-revoke-demo.json`](2026-09-27-revoke-demo.json), committed next
to this file.

## What ran

| Field | Value |
| --- | --- |
| Command | `HEDWIG_DEMO_KEYPAIR=<path> npm --prefix app run revoke-demo -- --out <path>` |
| Commit | `a7a7e176f0f77b731730c0b6c76c4985cfee09a6` |
| Clean tree | `true` (`git status --porcelain` was empty) |
| UTC start | `2026-09-27T18:36:40.715Z` |
| UTC end | `2026-09-27T18:36:45.334Z` |
| Network | Solana devnet, `api.devnet.solana.com` |
| Program id | `H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC` |
| MCP server pid | `7530`, all four asks |
| Admin | `Fq2NR6KBqKGUeJUR8qtY65SawLZFs1ZgnnXH27FQRWQj` |
| Org | `AFFoRYATGSsbXPvxWj9YPHhvpEbziykZHxttiKAuJods` (reused, no create_org tx) |
| Role | `FnZuwsx9C3xgQDzCzJBsZeB6njsBg6hmirSMXGbYh31q` |
| Holder | `AwkwCGR7hbgvx8pqn6peu9j1k7LgZpdHWYTDojoNwttZ` |

| Step | Transaction |
| --- | --- |
| create_role | [`CmAKPPVPWBLgj166Hasc5CQ7qDdd3VS9wwY7WcGxRdqrH4UwuDPnYpEr45m77FyQDoxK8GGLtgqQ3ufwzBwrnAT`](https://explorer.solana.com/tx/CmAKPPVPWBLgj166Hasc5CQ7qDdd3VS9wwY7WcGxRdqrH4UwuDPnYpEr45m77FyQDoxK8GGLtgqQ3ufwzBwrnAT?cluster=devnet) |
| assign_role | [`5VfdNDXvwiGZsM7E45DLJ3WLUPdVDF41P8LEavouQtkpQQKop9pjS4Bo4zVt8BwDF4B4SxyZ45tsWh4oemogdHis`](https://explorer.solana.com/tx/5VfdNDXvwiGZsM7E45DLJ3WLUPdVDF41P8LEavouQtkpQQKop9pjS4Bo4zVt8BwDF4B4SxyZ45tsWh4oemogdHis?cluster=devnet) |
| revoke_role | [`3en8dhiTnb29xVsCQnsGLCaZLtnVZJNYGNFc5hkxzZ2UUDkw3ygGQLVgJN1EsvmLDryuzgK9H5sMcuKZU3qbYE6V`](https://explorer.solana.com/tx/3en8dhiTnb29xVsCQnsGLCaZLtnVZJNYGNFc5hkxzZ2UUDkw3ygGQLVgJN1EsvmLDryuzgK9H5sMcuKZU3qbYE6V?cluster=devnet) |

## Outcomes

| Ask | Record key | Verdict | Proceed | `role-requirement-met` | `amount-within-cap` | Tx |
| --- | --- | --- | --- | --- | --- | --- |
| 1, allow | `ask1` | `ALLOW_UNDER_POLICY` | `true` | `ROLE_HELD` | `AMOUNT_WITHIN_CAP` | none |
| 2, over-cap | `overCapAsk` | `DENY` | `false` | `ROLE_HELD` | `AMOUNT_EXCEEDS_CAP` | none |
| 3, missing Fact | `missingFactAsk` | `UNKNOWN` | `false` | `ROLE_FACT_MISSING` | `AMOUNT_WITHIN_CAP` | none |
| 4, after revoke | `ask4` | `DENY` | `false` | `ROLE_MEMBER_MISSING` | `AMOUNT_WITHIN_CAP` | revoke_role [`3en8dhiTnb29xVsCQnsGLCaZLtnVZJNYGNFc5hkxzZ2UUDkw3ygGQLVgJN1EsvmLDryuzgK9H5sMcuKZU3qbYE6V`](https://explorer.solana.com/tx/3en8dhiTnb29xVsCQnsGLCaZLtnVZJNYGNFc5hkxzZ2UUDkw3ygGQLVgJN1EsvmLDryuzgK9H5sMcuKZU3qbYE6V?cluster=devnet) |

Ask 4 answered on its first attempt: the record has no `ask4FirstAttempt`.

## Reproduce

```bash
yarn consult:build && yarn mcp:build
HEDWIG_DEMO_KEYPAIR=<path to a devnet keypair outside the repository> \
  npm --prefix app run revoke-demo -- --out <path>
```
