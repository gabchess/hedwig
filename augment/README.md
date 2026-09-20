# Hedwig augment

> Planned. Nothing here installs yet.

The augment is the Hedwig package your agent loads: an expert on payment security, DeFi security and opsec that it consults before it acts onchain. Words this repository uses are fixed in [the glossary](../CONTEXT.md).

## What you will install

| Part | What it does |
| --- | --- |
| Front-door skill | Tells your agent what Hedwig covers and which capability to load. |
| Capability skills | One skill per job, added one at a time. |
| Knowledge base | Markdown references on payment security, DeFi security and opsec. |
| Checks as MCP tools | Deterministic tools the skills tell your agent to call. They are described in [the checks](../consult/README.md). |

## Where it runs

The first two layouts target coding agents that read skills from disk today. A GPT pack follows. Any other host reaches the checks over MCP or the API.

## First capability skills

- Pre-transaction check: what to confirm before your agent signs.
- Approval and allowance review: what an approval grants and how long it lasts.
- Address and contract identity: whether the target is the contract you meant.
- Admin-key and upgrade-authority review: who can change the contract after you deposit.

## Knowledge base rules

- Every factual line carries a source link and a date it was checked.
- Every reference is written fresh for this repository.
- Read-only: Hedwig never signs a transaction and never moves funds.

## Explicit non-goals

- Not a wallet.
- No key custody.
- No transaction simulation.
- No price or quote checks.
- No model in the MVP.
- No risk score.
- No hosted service.

## Honest limit

A skill and a check verdict are both advice your agent can ignore. Enforcement exists only where a program calls the onchain `check_role` and propagates its error.

## Tickets

Work is tracked in the [Build plan](https://github.com/gabchess/hedwig/milestone/1).
