# role-requirement-met

Every policy states the owner's choice about a Solana role: required, or
not required. When a role is required, the check reads a fact about that
role record, observed at a stated time and supplied by the caller of
`consult()` as data, the same way `facts.now` is, and compares its subject
with the cluster, program, role and holder the owner named. `consult()`
makes no network call. The check flags a stale fact, a fact about a
different role or holder than the one the owner named, and a fact that
reports the role as disabled, expired, or unassigned.

When the owner's policy sets `role.mode` to `"not-required"`, this row
passes without looking at any fact. A `mode: "required"` policy names a
`cluster` (`devnet`, `testnet` or `mainnet-beta`); a `programId`, `role`
and `holder`, each a base58 id of 32 to 44 characters; an optional `member`
id of the same shape, which this check never compares; and `maxAgeSeconds`,
the oldest a fact may be and still count, an integer from 1 to 60.

- PASS: `role.mode` is `"not-required"`, or it is `"required"` with a
  well-formed policy, a supplied `solanaRole` fact whose subject exactly
  matches the policy's cluster, program, role, and holder, an age within
  the owner's window, and `valid: true`.
- FAIL: the policy is `"required"` and well-formed, the fact's subject
  matches, its age is within the window, and `valid: false`: the role is
  disabled, the membership has expired, or the holder is not a member.
- UNVERIFIED: the policy's role field is missing or malformed, no fact was
  supplied or the fact is not a well-formed role record, the fact names a
  different cluster, program, role, or holder than the policy, or the
  fact's age cannot be confirmed or falls outside the owner's window.

## Sources

- Solana RPC documentation, "Configuring State Commitment", defining the
  `confirmed` and `finalized` commitment levels a fact's provenance names:
  https://solana.com/docs/rpc
