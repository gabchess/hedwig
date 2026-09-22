# Revoke demo, devnet, 2026-09-22

One run of `npm --prefix app run revoke-demo` from commit `dd63fe9`, against Solana devnet through `api.devnet.solana.com`. The MCP server (`mcp/dist/server.js`) was started once and answered both asks from the same process (pid 29700), with the same policy file and the same payment request. The policy required the role below.

| Item | Value |
| --- | --- |
| Admin | `Fq2NR6KBqKGUeJUR8qtY65SawLZFs1ZgnnXH27FQRWQj` |
| Org | `AFFoRYATGSsbXPvxWj9YPHhvpEbziykZHxttiKAuJods` |
| Role | `7Pic5dsfS1fNJgEVgVUMaBitkb2UBJ1mjM3dMZ5BEN57` |
| Holder | `8LkcQDekHkeiSXEN5prMssN6VKzFShB4d6J5n9Afmkg8` |

| Step | Transaction |
| --- | --- |
| create_org | [`2H5wyQvz...`](https://explorer.solana.com/tx/2H5wyQvzuUmZ7yXEtB3Wc3den8renojf8C6hRg8vr7HEVTsrWExW6bw8ZjAvMSg7o4WipgYn5V5i88UcYjcA6AGd?cluster=devnet) |
| create_role | [`4vqCXUib...`](https://explorer.solana.com/tx/4vqCXUib9iNoGEUGZDxVFihszNPTyGSoWiSuntNmbKVGgz2bZH4TvkNFnVYbJGhNEeDqrrdmr4Q2FbWYhxVFn2fX?cluster=devnet) |
| assign_role | [`pSxVMGDm...`](https://explorer.solana.com/tx/pSxVMGDmpj22LujLENMBtADQhNRe84ppgNxoLdBBR8drd49WbaHvMjQZN7yv71VaVW6U477eaHP8o1GyVL9HWJy?cluster=devnet) |
| revoke_role | [`3oJAoFLg...`](https://explorer.solana.com/tx/3oJAoFLgh1HFvpAe5T5THVtvBLyrPYxQ4YXWqQoU9e2s8eZd8QA3Qds2dDW72gtydfnCpJcWrTHRGQVdP1eqFABp?cluster=devnet) |

## Ask 1, after assign_role

| Field | Value |
| --- | --- |
| proceed | `true` |
| verdict | `ALLOW_UNDER_POLICY` |
| support | `0.92` |
| band | `green` |
| role-requirement-met | `PASS`, `ROLE_HELD` |

## Ask 2, after revoke_role

| Field | Value |
| --- | --- |
| proceed | `false` |
| verdict | `DENY` |
| support | `0` |
| band | `red` |
| role-requirement-met | `FAIL`, `ROLE_MEMBER_MISSING` |

The second ask was answered on its first attempt.
