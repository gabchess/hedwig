# Hedwig Architecture

Hedwig is an onchain authorization primitive organized around three domain
nouns: orgs, roles, and members. It has six domain actions. The repository keeps the
conventional Anchor shell while making the authorization model visible in file
and symbol names.

## Domain boundary

Hedwig answers one question: does this pubkey currently hold this role?

| Domain term     | Onchain meaning                                            |
| --------------- | ---------------------------------------------------------- |
| `Org`           | Namespace owned by one authority pubkey                    |
| `Role`          | Named authority under an org, controlled by its role admin |
| `Member`        | Account proving one holder pubkey belongs to one role      |
| Holder          | Pubkey named by a member account; not necessarily a signer |
| Circuit breaker | Role-wide enabled flag managed through `set_role_enabled`  |
| Role check      | CPI-friendly validation through `check_role`               |

Hedwig does not define what a role authorizes inside another program. It does not
authenticate the actor presented by that program, create delegation chains, or
evaluate token- or vote-based eligibility. Those policies belong to the consumer
or to wrapper programs.

## Account graph

```text
authority
  └─ Org ["org", authority]
       └─ Role ["role", org, role_name]
            └─ Member ["member", role, holder]
```

- One authority currently derives one org.
- A role name is part of its PDA seed and cannot be renamed.
- A role admin is initialized to the org authority. The current core has no
  instruction to transfer that admin field.
- A member may expire at a Unix timestamp; `0` means no expiry.
- Revocation closes the member PDA and decrements the role's member count.
- Disabling a role preserves members but blocks checks and new assignments.

Program ownership, Anchor account deserialization, PDA seed and bump checks, and
explicit `has_one` constraints enforce relationships between these accounts.
Discriminators identify account types; they do not establish account identity on
their own.

## Instruction flow

```text
create_org
    └─ create_role
         ├─ assign_role ── check_role
         ├─ revoke_role
         └─ set_role_enabled
```

The mutating instructions authenticate the relevant authority or role admin.
`check_role` is intentionally read-only and requires no holder signature. Its
account constraints bind `Member.role` to the supplied role and `Member.holder`
to the supplied holder; its handler then rejects disabled roles and elapsed
memberships.

For CPI use, the consuming program must authenticate the actor before invoking
`check_role` and propagating its `Result`; propagating an error aborts the
consuming instruction. See
[Caller authentication is an integration requirement](../../THREAT-MODEL.md#caller-authentication-is-an-integration-requirement)
for the full boundary and why `holder` is not itself a signer requirement.

The repository's reference consumer demonstrates the signer pattern. Its
counter PDA and stored authority are bound to the signer, the signer is passed
as Hedwig's holder, and `Program<HedwigSol>` pins the CPI target. The consumer
is a separate live devnet program and reference integration, not a new Hedwig
domain layer or evidence of independent adoption.

## Repository map

| Path                                    | Responsibility                                                  |
| --------------------------------------- | --------------------------------------------------------------- |
| `programs/hedwig_sol/src/lib.rs`        | Public six-instruction Anchor surface                           |
| `programs/hedwig_sol/src/instructions/` | One file per authorization action                               |
| `programs/hedwig_sol/src/state.rs`      | `Org`, `Role`, and `Member` account state                       |
| `programs/hedwig_sol/src/error.rs`      | Authorization and validation errors                             |
| `programs/hedwig_sol/src/constants.rs`  | PDA seed and account-size constants                             |
| `programs/hedwig_sol/tests/`            | LiteSVM behavior and lifecycle tests                            |
| `programs/hedwig_consumer/`             | Secure CPI reference consumer and negative tests                |
| `sdk/`                                  | Repository-local six-instruction TypeScript SDK alpha           |
| `app/`                                  | SDK-driven core lifecycle and live consumer-integration clients |
| `docs/access-control/integration-guide.md`             | Actor binding, CPI, and local SDK usage                         |
| `docs/grants/progress.md`                | Public shipped-work and claim-evidence ledger                   |
| `docs/deployment/operations.md`                    | Devnet upgrade, verification, rollback, and incident steps      |
| `THREAT-MODEL.md`                       | Trust boundaries and security posture                           |

Integration risks, especially holder authentication and upgrade authority,
belong in [THREAT-MODEL.md](../../THREAT-MODEL.md), not in this code map.
