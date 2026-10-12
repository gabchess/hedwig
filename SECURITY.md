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

`consult/` and `mcp/` on `main`, and the v0.4.2 release that the install guide
uses. There is no bug bounty.

The MCP server holds no signing key, and Hedwig never signs or sends. If you
wrap your own signer with `runTriggerGuard` from `@hedwig/consult/guard`, your
code calls that signer, not Hedwig. When Hedwig can't check a request, it says
so and tells your agent to stop.
