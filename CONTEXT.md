# Hedwig

Hedwig is the safety trigger an agent checks with before it acts onchain. This file fixes the words this repository uses, so that a reader and an agent name the same thing the same way.

## Language

**Safety trigger**:
What Hedwig is to the person who runs an agent: the thing that agent checks with before it acts onchain.
_Avoid_: oracle, gatekeeper, guardrail

**Owner**:
The person whose agent pays, trades or signs on their behalf.
_Avoid_: end user, consumer

**Caller**:
The agent that consults Hedwig.
_Avoid_: client, bot

**Host**:
The app the augment is installed in, such as a coding agent, a CLI agent or another MCP client.
_Avoid_: platform, IDE

**Augment**:
The installable Hedwig package: a front-door skill, capability skills, the knowledge base and the checks. `Plugin` names the packaging for one host, never the product.
_Avoid_: plugin, v2, suite

**Knowledge base**:
The markdown references inside the augment covering payment security, DeFi security and opsec.
_Avoid_: docs, corpus, dataset

**Consult**:
One request from a caller, asking about an action it is about to take.
_Avoid_: query, lookup

**Check**:
A deterministic rule that reads records and returns a verdict.
_Avoid_: scan, rule engine

**Verdict**:
The answer a check returns: `ALLOW_UNDER_POLICY`, `DENY` or `UNKNOWN`.
_Avoid_: safe, score, risk level

**Chain**:
An onchain network a check can be asked about. Chain ids follow CAIP-2.
_Avoid_: network, L1, L2

**Role record**:
The onchain record of which agent holds which role, with an expiry the owner can revoke.
_Avoid_: permission, ACL

**Policy**:
The local file where a team states which roles may call which targets.
_Avoid_: config, ruleset

**Registry record**:
The reviewed entry for one contract, carrying its address, evidence links and verified-at slot.
_Avoid_: allowlist entry, whitelist

**Opsec model**:
The planned model that reads, explains and flags, while checks make the call.
_Avoid_: AI, brain, agent

**Shipped**:
Built, deployed and backed by evidence in this repository today.
_Avoid_: live, production, ready

**Planned**:
Decided and written down, with nothing built.
_Avoid_: coming soon, in progress, beta

**Later**:
Planned for after funding, with no date attached.
_Avoid_: roadmap item, someday
