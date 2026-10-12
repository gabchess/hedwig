# Security

## Report privately

Use [GitHub's private advisory form](https://github.com/gabchess/hedwig/security/advisories/new). If it's down, reach the owner through their GitHub profile and ask for a secure channel.

Don't post exploit details, private keys, RPC credentials or a working proof of concept in a public issue.

Send the commit or tag, the impact, the access an attacker needs, and the exact steps to reproduce. A suggested fix helps.

## Scope

`consult/` and `mcp/` on `main`, the release the install guide uses, and `usehedwig.xyz/agents.md`. No bug bounty.

Hedwig holds no keys and never signs or sends. When it can't check a request, it says so and tells your agent to stop.
