# Hedwig threat model

This document defines the security boundary of Hedwig and its reference
consumer. It distinguishes checks enforced by Hedwig from checks an integrating
program must perform. The live Hedwig deployment contains all six reviewed
instructions, including the `set_role_enabled` circuit breaker.

Hedwig has not completed an external security review. The 29 core and 12
consumer LiteSVM integration tests are evidence of the tested behaviors below,
not a substitute for one.

## Assets and security properties

Hedwig holds three kinds of state:

- an `Org` identifies the authority allowed to create roles in its namespace;
- a `Role` identifies its org and the admin allowed to manage memberships or disable the role;
- a `Member` identifies one holder's membership in one role, with optional expiry.

The program is intended to enforce these properties:

1. Only an org authority can create a role under that org.
2. Only a role admin can assign or revoke membership and toggle that role.
3. A successful `check_role` means the supplied holder has the supplied role, the role is enabled, and the membership has not expired.
4. Revoking a membership or disabling its role makes subsequent checks fail.
5. Failed instructions do not partially update counters or close accounts.

## Trust assumptions

| Component                       | Current controller                                         | Consequence if compromised                                                                               |
| ------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Org authority                   | Signer that created the org                                | Can create any role in that org. The authority cannot currently be rotated.                              |
| Role admin                      | Org authority recorded when the role is created            | Can assign and revoke memberships and enable or disable the role. The admin cannot currently be rotated. |
| Program upgrade authority       | Pubkey `8gba...HPqY` for Hedwig and the reference consumer | Can replace either live program. This is the highest current deployment risk.                            |
| Solana runtime and Clock sysvar | Solana validator consensus                                 | Supply account ownership, transaction atomicity, signatures, and time used by expiry checks.             |
| Integrating program             | Its own upgrade and instruction authorities                | Must authenticate the actor whose membership it asks Hedwig to check.                                    |
| Caller's process                | The caller                                                 | Controls the globals, prototypes and signer the guard uses, so it can sign anything, guard or no guard.  |

No offchain service, indexer, or cache participates in an onchain role check.

## Account identity and substitution

PDA seeds are public; secrecy of seeds is not a security control. Hedwig relies on Solana program ownership and Anchor account validation:

- account discriminators establish the expected account type;
- PDA seeds and stored bumps bind each account to its canonical address;
- `has_one` constraints bind stored relationships such as member-to-role, member-to-holder, org-to-authority, and role-to-admin;
- required authorities and admins are transaction signers on mutating instructions.

A discriminator alone does not prove that an account is the correct org, role, or member. The seed and relationship constraints provide that binding.

The canonical addresses are:

```text
Org:    ["org", authority]
Role:   ["role", org, role_name]
Member: ["member", role, holder]
```

This layout allows one `Org` per authority and one `Role` per name within an org. It also prevents duplicate membership for the same role-holder pair while the original `Member` account exists.

## The payment check's boundary

`consult()` reads three inputs: the request the caller maps, the owner's
policy file, and the facts the caller supplies as data. It makes no network
call, reads no clock, holds no key, and signs nothing.

The caller controls the request and the facts. A caller that misreports
either gets an answer about what it reported.

The owner controls the policy file: the approved recipients, the caps, the
named chain, the role choice and the authorization window. The MCP server
reads that file from the path in `HEDWIG_POLICY_FILE`, and reads a required
Solana role through the RPC endpoint named in the environment.

The server hashes the policy file's bytes when it starts and compares every
later read to that hash. Within one server run, a caller that can write the
file cannot add its own recipient and get the next request approved: any change
to the file's bytes, by an edit, a replacement or a symlink swap, answers
`UNKNOWN` with `ADAPTER_POLICY_CHANGED`. A deleted file, a file larger than
256 KB (262,144 bytes), or a directory or FIFO in the file's place answers
`UNKNOWN` with `ADAPTER_POLICY_UNREADABLE`. So does every call in a run that
started while the file could not be read. The reply says only that the file
changed; the restart advice goes to stderr, for the Owner.

The pin lasts as long as the server process. Every server start, which means
every client session and every reconnect, hashes whatever the file holds at
that moment and accepts it with no warning. A caller that can write the file
can also make the server exit, for example with a message over 256 KB, and
the next start pins the caller's version. To stay safe across restarts, the
Owner reviews the file before restarting the server, or keeps it where the
agent's OS user cannot write it. The pin does not stop a caller that can
change the file before the server starts, or that can change the server's
environment or binary.

The hash covers bytes, not meaning. Replacing the file with identical bytes
or changing its permissions in a way that keeps it readable does not change
the answer. A permissions change that makes the file unreadable answers
`UNKNOWN` with `ADAPTER_POLICY_UNREADABLE`. Only the pinned bytes can ever be
approved.

Hedwig returns `proceed`, a verdict, and one row per Condition. Acting on
that answer is the caller's own step.

### The Trigger guard

A caller can hand that step to the Trigger guard, `runTriggerGuard` in
`@hedwig/consult/guard`. The caller passes its payment, a function that maps
the payment to a request, the policy, an optional `gather` function for facts,
and its own signer. The guard holds no key. It signs only through the signer
the caller injects.

The guard maps the request once. Right after the mapping returns, and before
`gather` runs, it turns the request into its own JSON snapshot. `gather`,
`consult()` and the signer all receive that same data, and the guard never
reads the caller's object again.

The verdict comes from `consult()`; the guard's input has no field for one.
The guard calls the signer at most once, and only when the verdict is
`ALLOW_UNDER_POLICY`, passing it the `action` from the frozen data.

## Caller authentication is an integration requirement

`check_role` proves a statement about the supplied `holder` pubkey. It does not prove that the transaction caller controls that pubkey: `holder` is intentionally not a signer because programs may need to check wallets, multisigs, or program-derived authorities.

A consuming program must bind `holder` to the actor it intends to authorize before trusting a successful CPI. Depending on the integration, that means requiring a `Signer`, validating a PDA owned by the consumer, or applying another explicit identity constraint. Failing to do so can let a caller present someone else's active membership.

The repository ships a tested reference consumer that requires a signer, binds
its counter PDA and stored authority to that signer, passes the same account as
Hedwig's holder, and pins the Hedwig program type. The consumer is live on
devnet and its first state change is recorded publicly. It remains builder-owned
and is not an external integration or production evidence.

## Membership lifecycle

### Assignment and expiry

`assign_role` accepts `expires_at = 0` for a non-expiring membership. Any nonzero value must be strictly later than the current Clock timestamp at assignment.

`check_role` treats the membership as valid while `Clock::unix_timestamp <= expires_at` and returns `MembershipExpired` after that point. Expiry blocks future checks but does not close the `Member` account or decrement `member_count`; an admin must still revoke the membership to reclaim rent and update the counter.

### Revocation

`revoke_role` requires the role admin, verifies the member-role relationship, decrements `member_count` with checked arithmetic, and closes the `Member` account. A later check cannot use the closed membership.

### Role circuit breaker

`set_role_enabled` requires the role admin. Disabling a role makes `check_role` fail for every member and blocks new assignments; it does not delete existing memberships. Re-enabling the role restores checks for memberships that have not expired or been revoked.

## Availability and denial of service

Hedwig has no application-global writable account. Write contention and authority failure are therefore scoped to an org, role, or membership rather than shared across every Hedwig user.

This does not eliminate denial-of-service risk. An unavailable or compromised admin can prevent legitimate membership changes for its role, Solana congestion can delay transactions, and a consumer can make its own instruction unusable through incorrect account constraints or compute budgeting. Hedwig does not provide recovery or rotation instructions for an unavailable org authority or role admin in the current program.

## Fixed cardinality and immutable authorities

The current address scheme and instruction set deliberately impose these constraints:

- one org per authority, because the org PDA is derived from `["org", authority]`;
- one role with a given name per org, because the role name is part of the role PDA seeds;
- immutable org authority and role admin, because no rotation instruction exists.

Supporting multiple orgs per authority or authority rotation would change the state model or instruction surface. It requires a new reviewed decision and migration plan, not a silent change to the deployed program.

No admin or authority rotation instruction exists in the deployed program.

## Deployment and upgrade authority

As checked on 2026-07-24, the devnet program was upgraded at slot `478655638`
and its upgrade authority remained
`8gbaJEfM5VDs9BpFLgwMTq7s2FkVpEri8ZnPbxn4HPqY`. The reviewed compiled ELF
matched every deployed code byte; the larger ProgramData allocation contained
only zero bytes after the ELF. The repository records the authority as a single
deployer-controlled key. A compromise could bypass every invariant described
above by deploying different code.

The live lifecycle called all six instructions and fetched `enabled=false`
after the circuit breaker was set. This proves that transaction path on devnet,
not independent production use or mainnet safety.

The reference consumer was deployed at slot `478667066` under program ID
`52D3pTYvMwLYbiigY5xg55n4HmtEzTKCEicx1Cojzo9a`. Its live 176,264-byte dump
matches the reviewed artifact byte for byte. A fresh authenticated actor then
incremented a consumer-owned counter through Hedwig CPI. Both programs retain
the same single deployer-controlled upgrade authority, so the live integration
does not reduce the upgrade-key risk.

The ignored local keypair at `target/deploy/hedwig_sol-keypair.json` does not
derive the fixed devnet program ID. Every upgrade must therefore name
`H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC` explicitly and must deploy the
artifact whose hash was recorded by the release audit.

The upgrade authority is one deployer-controlled key on both programs.

## Test evidence

The current 29-test core LiteSVM suite covers:

- rejected non-authority role creation;
- rejected non-admin assignment, revocation, and role toggling;
- wrong-holder and wrong-role checks;
- before, equal, and after-expiry checks plus invalid assignment timestamps;
- revoked, closed, re-granted, and duplicate memberships;
- disabled-role and re-enable behavior;
- byte-length boundaries for org and role names;
- checked `role_count` and `member_count` lifecycle updates;
- exact error and unchanged-state assertions on negative paths; and
- a pinned by-design case proving `check_role` succeeds for an unrelated
  caller, so a future contributor cannot silently turn the documented
  integration contract into a signer requirement.

The 12-test consumer suite covers:

- an authenticated member incrementing protected state;
- a privileged third party that cannot be substituted for the actor;
- missing and wrong consumer authority;
- wrong role, expired, disabled, and revoked membership;
- duplicate consumer initialization;
- checked counter overflow;
- a substituted Hedwig program; and
- a role account with the wrong owner.

The TypeScript SDK has 27 tests for PDA derivation, all six builders and senders,
IDL vectors, UTF-8 limits, expiry conversion, signer forwarding, and provider
failure. The payment check has 500 tests, the MCP server 165, and the demo app
51. These suites do not establish independent adoption, upgrade-key
operations, Squads governance, external review, or mainnet safety.

## Out of scope for the current devnet program

- holder authentication inside `check_role`;
- authority or admin rotation and recovery;
- role hierarchy, inheritance, or holder-driven delegation;
- spending limits or transaction policy enforcement;
- token-gated assignment and Token-2022 badges;
- cross-program propagation hooks;
- formal verification.

These features belong in integrating or wrapper programs unless a reviewed
product change expands the small-core boundary.

## Reporting vulnerabilities

Do not open a public issue for an undisclosed vulnerability. Follow
[`SECURITY.md`](SECURITY.md) to use GitHub's private advisory flow or request a
private maintainer channel. There is no bug bounty program at this stage.
