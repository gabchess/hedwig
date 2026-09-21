# chain-matches-intent (swap)

The request's chain identifier is checked against the chain the owner
named in their policy, both parsed as a CAIP-2 chain id (for example
`eip155:1`). The check flags a swap meant for one chain that is about to
run on a chain the owner did not name.

- PASS: both chain ids are well-formed CAIP-2 ids and match exactly.
- FAIL: both chain ids are well-formed CAIP-2 ids but do not match.
- UNVERIFIED: either chain id is not a well-formed CAIP-2 id.

## Sources

- Chain Agnostic Improvement Proposals, CAIP-2: "Blockchain ID Specification": https://chainagnostic.org/CAIPs/caip-2
