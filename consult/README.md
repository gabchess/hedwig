# Hedwig checks

> Planned. Nothing in this folder runs yet.

These are the deterministic checks the augment exposes over MCP and an API. The package that installs them is described in [the augment](../augment/README.md). Words this repository uses are fixed in [the glossary](../CONTEXT.md).

## What it will answer

Slice 1 answers one question on one chain: may this agent call this program under our rules? The answer joins three records.

| Record | Where it lives | What it supplies |
| --- | --- | --- |
| Member | Onchain, in the shipped role record. | Who holds which role right now. |
| Policy | A local `hedwig.policy.json` file your team owns. | Which roles may call which targets, plus the maximum registry age. |
| Registry record | A JSON registry in git, changed only by PR. | The address, two evidence URLs and a verified-at slot. |

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `ALLOW_UNDER_POLICY` | The call matches an unexpired role and your policy permits it. |
| `DENY` | A record rules the call out. |
| `UNKNOWN` | The records on hand do not settle the question. |

A check fails closed: a missing record, a stale record, an RPC error or any mismatch returns `UNKNOWN`.

## Chains

The target is onchain payments wherever they happen. Chain ids follow CAIP-2 in both the registry and the policy file from day one, so adding Ethereum, Monad or another EVM chain means adding registry data. The code starts on Solana because the shipped role record lives there.

## Explicit non-goals

- Not a wallet.
- No key custody.
- No transaction simulation.
- No price or quote checks.
- No hosted service in slice 1.
- No model in the verdict path.
- No risk score.

## Non-obvious decisions

- The crate `hedwig_sol`, both program IDs, the IDL and the package `@hedwig-sol/sdk` keep their old names. They are bound to deployed devnet evidence that a rename would break.
- The member record is read by simulating the shipped `check_role` instruction. An answer computed any other way can drift from what the program would do.
- Every response carries typed evidence and no free text. A caller parses the verdict, and prose invites a reader to argue with it.
- One deployable: a local package with a pure core function and two thin adapters, MCP over stdio first, then `POST /consult` on localhost. Nothing hosted in slice 1 means no server to run or trust.
- Judged screens run behind a flag, logged only, and may move a verdict toward caution. A verdict a model can widen is a verdict nobody can audit.

## Gates before anything here is called shipped

- A: the wedge is named in writing, which is a team policy joined with a revocable onchain grant.
- B: an adversarial fixture covers the fail-closed contract before any live path exists, so a known clone never returns an allow.
- C: one demand signal from a builder who does not work on this repository.
- D: caller identity for the consult call is designed, so an agent cannot earn an allow by lying about who it is.

## Tickets

Work is tracked in the [Build plan](https://github.com/gabchess/hedwig/milestone/1).
