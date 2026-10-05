# Security policy

Hedwig's open-source prototype checks payment and swap proposals through
TypeScript or MCP. Its Solana role program records which pubkeys hold which
roles. There is no bug bounty program.

## Report privately

Use [GitHub's private security-advisory form](https://github.com/gabchess/hedwig/security/advisories/new).
If that form is unavailable, contact the repository owner through the private
contact route on their GitHub profile and ask for a secure channel.

Do not open a public issue with exploit details, private keys, RPC credentials,
or a working proof of concept.

Include:

- affected commit, program ID, and cluster;
- impact and required attacker access;
- exact reproduction steps;
- relevant transaction signatures, accounts, logs, or test code; and
- any suggested mitigation.

## Scope

The current supported targets are the repository's reviewed devnet commit and
the fixed core and reference-consumer program IDs listed in [`THREAT-MODEL.md`](THREAT-MODEL.md). The
reference consumer is deployed on devnet. The repository-local SDK alpha remains a
repository test surface and is not published. `@hedwig/consult` and `@hedwig/mcp` are in scope at the reviewed commit. Both are `private` and neither is published.

The hosted expert service is in development. Current deployment evidence
covers Solana devnet. The website is public; a website deployment does not
establish a hosted payment-check service or a mainnet program deployment.

## Response

The maintainer will preserve the report privately, validate reachability and
impact, and follow [`docs/deployment/operations.md`](docs/deployment/operations.md) for containment,
recovery, evidence handling, and incident follow-up.
