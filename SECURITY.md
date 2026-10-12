# Security policy

## Report privately

Use [GitHub's private security-advisory form](https://github.com/gabchess/hedwig/security/advisories/new).
If the form is unavailable, contact the repository owner through the contact
route on their GitHub profile and ask for a secure channel.

Do not open a public issue with exploit details, private keys, RPC credentials
or a working proof of concept.

Include:

- the affected commit or tag;
- the impact and the access an attacker needs;
- exact steps to reproduce; and
- any fix you suggest.

## Scope

`consult/` and `mcp/` on `main`, the release the install guide uses, and the install page at `usehedwig.xyz/agents.md`. There is no bug bounty.

Hedwig holds no signing key and never signs or sends. `runTriggerGuard` from
`@hedwig/consult/guard` runs in your process and calls the signer you pass it at
most once, only after the check allows. When Hedwig can't check a request, it says
so and tells your agent to stop.
