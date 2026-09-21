# role-requirement-met

The owner may require the agent to currently hold a named role on a Solana
program: an org, a role name, and the holder pubkey the role was assigned
to. The check reads a fact about that role record, observed at a stated
time by the caller of `consult()`, and compares it with the holder the
owner named. It never calls Solana itself; the fact is supplied as data,
the same way `facts.now` is. The check flags a stale fact, a fact about a
different role or holder than the one the owner named, and a role the
owner's own program reports as disabled, expired, or unassigned. It does
not claim that the agent controls the holder key: proving a transaction
signer is the named holder is a separate concern for the caller integrating
this Condition's result.

When the owner's policy sets `role.mode` to `"not-required"`, this row
passes without looking at any fact: the owner asked for no role, so none is
owed. A `mode: "required"` policy names `cluster`, `programId`, `role`, and
`holder` (each a 32-to-44-character base58 id), an optional `member` id the
Reader that turns a role record into a fact will use, and `maxAgeSeconds`,
the freshest a fact may be and still count.

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
