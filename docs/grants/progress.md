# Grant progress ledger

This ledger records Hedwig's progress toward its USDG 3,000 grant. USDG 1,500
has been received and USDG 1,500 remains. The maintainer reports that the
authenticated portal exposes a final-tranche request form and the grant
program's general completion policy. This portal state is not publicly
verifiable, and no project-specific milestone or KPI text was found. Public
software and deployment claims below link to code, tests, or live evidence.

This file records delivery. It does not claim that the grant issuer accepted a
milestone, that a repository fixture is a customer, or that unobserved demand
exists.

Public delivery review:
[`#3: Ship secure consumer integration and grant evidence`](https://github.com/gabchess/hedwig/pull/3)

## Preparation work started on 2026-07-29

| Delivery | Public evidence | State |
| --- | --- | --- |
| Seven-day pilot offer | [pilot program](../history/2026-07-shared-authorization-pilot.md) | Published |
| Public preparation and claim record | [pilot preparation record](../history/2026-07-29-pilot-preparation.md), [roadmap](../../ROADMAP.md) | Published |
| Signed pilot | External signed scope | Open |

No signed pilot, design partner, customer, revenue, production use, or external
adoption was created by this preparation work.

## Shipped on 2026-07-24

| Delivery                                             | Public evidence                                                                                                                  | State                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Six-instruction core, including role circuit breaker | [`programs/hedwig_sol`](../../programs/hedwig_sol), [threat model](../../THREAT-MODEL.md)                                              | Live on devnet                       |
| Secure actor-bound CPI consumer                      | [`programs/hedwig_consumer`](../../programs/hedwig_consumer), [integration guide](../access-control/integration-guide.md)                             | Tested and live on devnet            |
| Six-instruction TypeScript SDK alpha                 | [`sdk`](../../sdk)                                                                                                                  | Repository-local package; 27 tests   |
| SDK-driven six-instruction lifecycle                 | [`app/demo.ts`](../../app/demo.ts), [core promotion record](../deployment/evidence/2026-07-24-devnet-promotion.md)                                  | Verified on devnet                   |
| Hedwig-gated state change in a separate program      | [`app/consumer-demo.ts`](../../app/consumer-demo.ts), [consumer promotion record](../deployment/evidence/2026-07-24-consumer-devnet-integration.md) | Verified on devnet                   |
| Commit-pinned AI-assisted security and code review   | [full audit](../security/reviews/2026-07-24-full-audit.md)                                                                                    | Published with open risks            |
| Reproducible release checks and CI hardening         | [workflow](../../.github/workflows/ci.yml), [operations runbook](../deployment/operations.md)                                                     | Shipped                              |
| Public architecture and evidence-gated roadmap       | [architecture](../access-control/architecture.md), [roadmap](../../ROADMAP.md)                                                                        | Shipped                              |

## Verification totals

- 42 Rust tests passed: 28 core integration tests, 12 consumer integration
  tests, and two program-ID tests.
- 27 TypeScript SDK tests passed.
- Both SBF programs built from the reviewed source.
- The live core dump matches the reviewed ELF with documented zero-filled
  loader allocation padding.
- The live consumer dump matches its 176,264-byte reviewed artifact exactly.
- The live core lifecycle and consumer CPI state change both finalized on
  devnet.

## Current claim

Hedwig now has a small live role registry, a tested SDK, and a builder-owned
reference integration that authenticates the actor before checking its role.
The integration boundary is implemented, AI-reviewed, deployed, and
reproducible.

Hedwig still has no verified independent design partner, customer, revenue,
production use, independent external audit, or mainnet release.

## Next claim gate

The July seven-day pilot above is historical. When work resumes, the next
product exercise is [one agent and one protected action](../agent-access/integration-proof.md).
It must show authenticated success, confirmed revocation or elapsed expiry, and
a denied retry with unchanged protected state. An independent team's decision
to retain the integration is separate demand evidence.

This change in product focus does not claim a new grant milestone, accepted
completion, additional payment, or customer adoption. The grant facts above
remain recorded history until the issuer supplies new evidence.

## Later security work

- Move upgrade authority to a rehearsed 2-of-3 Squads multisig before mainnet.
- Obtain an external security review of a stable candidate.

The roadmap is canonical for delivery order:
[`ROADMAP.md`](../../ROADMAP.md).
