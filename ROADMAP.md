# Hedwig roadmap

Hedwig is becoming the augment an onchain agent consults before it pays: an expert on payment security, DeFi security and opsec that installs as a plugin or an MCP server, on any chain where agents move money. One piece of that is live today, the revocable role record on Solana devnet. Everything else here is planned, and this file says which is which.

## Now: the MVP

Two pieces, in this order.

**The augment first.** An installable package with a front-door skill, capability skills added one at a time, and a knowledge base of markdown references covering token approvals and allowances, lookalike addresses, cloned contracts, admin keys and upgrade authority, signing hygiene for agents, x402 payment flow risks and a pre-transaction checklist. It is markdown, so it ships in days. A skill is advice an agent can ignore, so it carries evals for the scenarios it must flag.

**The checks second.** Deterministic checks exposed as MCP tools and a local API, answering one question on one chain to start: may this agent call this program under the installing team's rules? The answer joins three records. The onchain member record says who holds which role now. A local policy file, owned by the installing team, says which roles may call which targets. A registry record in git says what an address is, who holds its upgrade authority and when it was last verified.

Verdicts are `ALLOW_UNDER_POLICY`, `DENY` and `UNKNOWN`. Every response is advisory and carries the chain, the registry revision, which checks ran and typed evidence. A missing record, a stale record, an RPC error or any mismatch returns `UNKNOWN`.

The MVP uses no model. Chain ids follow CAIP-2 from the first commit, so a second chain is a data addition.

Ticket-level detail lives in the [build plan](https://github.com/gabchess/hedwig/milestone/1).

## Shipped

Only the role record. It runs on Solana devnet.

### Six-instruction core

The source implements `create_org`, `create_role`, `assign_role`, `check_role`, `set_role_enabled` and `revoke_role`.

The local core suite contains 29 LiteSVM integration tests plus its generated program ID test. The current devnet program at `H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC` contains the reviewed six-instruction artifact deployed at slot `478655638`.

### Secure CPI reference consumer

`programs/hedwig_consumer` is a minimal program that requires an authenticated signer, binds its counter PDA and stored authority to that signer, and passes the same account to Hedwig as the holder. Its 12 LiteSVM integration tests cover the successful path and the main authorization, account, lifecycle, program-substitution and overflow failures.

Shipped on devnet at `52D3pTYvMwLYbiigY5xg55n4HmtEzTKCEicx1Cojzo9a`. The reviewed 176,264-byte artifact was deployed at slot `478667066`, and the July 24 live dump matched it byte for byte. A fresh authenticated actor then created a Hedwig role and membership, initialized a consumer-owned counter, and incremented it from zero to one through `check_role` CPI.

That proves the live integration path. The consumer is maintained by the Hedwig builder, so it does not count as independent use.

### TypeScript SDK alpha

The repository-local `@hedwig-sol/sdk` alpha contains typed PDA helpers, argument validation, generated IDL types, and build and send pairs for all six instructions. The demo imports this package instead of rebuilding raw Anchor calls. Its suite contains 27 tests.

Built and tested locally as `0.1.0-alpha.0`. It is not published to npm.

### Review and devnet promotion

The 2026-07-24 release gate covered the core, consumer, SDK, demo, CI, docs and deployment process at one commit. It proved:

- no unresolved Critical or High code finding that applies to devnet;
- the consumer built first and Hedwig built last;
- the deployment command pinned to the fixed program ID;
- the compiled ELF matched every deployed code byte, with only zero-filled loader allocation padding after it; and
- the exact six-instruction live lifecycle completed, including the disabled Role state and closed Member account.

The single-key upgrade authority remains a named mainnet blocker. It does not invalidate the completed devnet-only upgrade. See the [review](docs/security/reviews/2026-07-24-full-audit.md), the [core promotion record](docs/deployment/evidence/2026-07-24-devnet-promotion.md) and the [consumer promotion record](docs/deployment/evidence/2026-07-24-consumer-devnet-integration.md).

The [grant progress ledger](docs/grants/progress.md) maps shipped work to public artifacts and holds the funding and delivery facts.

## Later

**The opsec model, after funding.** An open-source model adapted with retrieval, fine-tuning and LoRA on security material. It reads, explains and flags. Deterministic checks decide. The model may move a verdict toward caution and may never produce an allow, because a wrong go-ahead costs the user money. Infrastructure for this waits on funding.

**More chains, as registry additions.** Ethereum, Monad and other EVM chains enter as data once the registry and policy carry CAIP-2 ids. A chain adapter interface waits until the second chain arrives.

**Role admin and org authority rotation.** This stays the named next build for the shipped piece. No code exists yet.

`Role.admin` is fixed at `create_role` and `Org.authority` is fixed at `create_org`. The six-instruction surface has no way to change either field, so a departed or compromised key permanently strands every role and membership under it once the holder can no longer sign. Rotation helps a holder who still controls a key and wants to move to a new one. It does not recover a key that is already lost. THREAT-MODEL.md names the gap under ["Fixed cardinality and immutable authorities"](THREAT-MODEL.md#fixed-cardinality-and-immutable-authorities).

It ships as two instructions, `rotate_org_authority` and `rotate_role_admin`, each gated on the current key's signature. Rotating `Role.admin` is a field write with no further consequences, because no PDA seed contains `admin`. Rotating `Org.authority` needs a companion change: the `Org` PDA seeds are `["org", authority]`, so `create_role` must drop its `seeds` and `bump` constraints on the `org` account and gate on `has_one` alone, the pattern `assign_role`, `revoke_role` and `set_role_enabled` already use. `Account<'info, Org>` still checks program ownership and the account discriminator, so no authorization is lost. Two consequences to plan for: the impostor error in `create_role` changes from `ConstraintSeeds` to `Unauthorized`, so `test_create_role_rejects_non_authority` must be updated in the same change, and `deriveOrgPda(authority)` resolves an org only from its original creating key, so callers need the org address. No account layout changes, so accounts already live on devnet keep working.

**Governed upgrade authority, then mainnet.** Move the devnet program upgrade authority from the deployer key to a 2-of-3 Squads multisig and rehearse one governed upgrade. Deploy to mainnet only after multisig custody, an external human security review with scope, commit, findings and remediation status, reproducible release evidence, and an external production-bound integration are all complete.

## Gates before anything new is called shipped

- **A. The wedge is named in writing.** Team policy joined with a revocable onchain grant, stated in the repository before the code that implements it.
- **B. The fail-closed contract has an adversarial fixture.** A known clone must never return an allow, and that test must exist before any live path does.
- **C. One demand signal from outside this project.** A builder with no connection to the maintainer asks for the thing. Builder fixtures and the reference consumer do not count.
- **D. Caller identity is designed.** An agent must not earn an allow by lying about who it is. The design lands before the consult accepts a real caller.

Status claims link to tests, review evidence, deployment output or external artifacts.

## Explicit non-goals

- No hosted service in the MVP. The checks run as a local package the caller installs.
- No model in the MVP, and no training claim about dataset, base model or benchmark until one exists.
- No integration, partnership, customer or parity claim with any wallet, rail or agent product.
- No chain adapter abstraction before the second chain has a real caller.
- No judged or model-scored screen inside the verdict path. Those run behind a flag, logged only, and may move a verdict toward caution alone.
- No role hierarchy, eligibility modules, badges, claimable roles, delegation, instruction allowlists, spending caps, indexer dashboard or standalone Rust CPI crate, until an observed integration exposes the missing primitive.
- No mainnet deploy, and no removal of upgrade authority, before the gates above are met.
