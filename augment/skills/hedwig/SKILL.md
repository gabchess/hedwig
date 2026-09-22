---
name: hedwig
description: Consult Hedwig before an agent signs a pay or swap transaction, and read its verdict correctly.
---

# Hedwig

Hedwig answers one question: should this agent proceed with this pay or
swap under the owner's policy? It never signs, sends, or holds a key. It
reads a request and a policy and returns a verdict.

## Prime directives

1. Act on `proceed` only. A green `band` or a high `support` is not permission.
2. Treat `support` as a report on how strong the proof was, never a threshold to clear.
3. Any UNVERIFIED row on the Floor means stop and ask the owner, never proceed and never guess.
4. Never rewrite, retry, or reshape a request to turn a FAIL or an UNVERIFIED row into a PASS.
5. Never supply `facts` from this agent's own guess; a fact is an observation the caller's own adapter made.
6. The policy is the owner's file. This agent never edits it, substitutes it, or writes its own.
7. A DENY is final for this exact request. Resubmitting it does not earn a different answer.
8. `consult()` judges only what is in the request and the policy, and makes no separate judgment call of its own.
9. Read `results` before acting. The worst row is listed first, and its `evidence` names the reason.

## How to call Hedwig

Through the MCP server, call the `consult` tool with `{ "request": <the pay or swap request> }`.
The server supplies the policy and the facts; the caller supplies only `request`.

From code, `consult(request, policy, facts?)` from `@hedwig/consult` returns the same response.

## The verdict grammar

`verdict` is one of three values: `ALLOW_UNDER_POLICY` (every Floor row PASS, policy permits),
`DENY` (at least one FAIL), or `UNKNOWN` (a mix, an UNVERIFIED row, or a policy that does not
permit). `proceed` is exactly `verdict === "ALLOW_UNDER_POLICY"`. `band` (`green`/`amber`/`red`)
is derived from `support` after the verdict and decides nothing.

Each row in `results` carries `id`, `question`, `status` (`PASS`/`FAIL`/`UNVERIFIED`), `code`,
`evidence`, `evidenceClass`, and `reference`. `results` lists the worst status first.

For the full Condition catalog, every question, code, and evidence class, read
[references/conditions.md](references/conditions.md). For allowances and permits, read
[references/approvals.md](references/approvals.md). For how a recipient is checked, read
[references/recipients.md](references/recipients.md). For mapping an x402 payment
requirement into a `pay` request, read
[references/x402-payments.md](references/x402-payments.md).

## Example: a clean payment

Request:

```json
{ "action": { "type": "pay", "chainId": "eip155:1",
  "recipient": "0x00000000000000000000000000000000a11ce001",
  "asset": { "symbol": "USDC", "contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  "amount": "1000000", "target": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" } }
```

Response (`results` truncated to its first row; every row here PASSes):

```json
{ "question": "Should this agent proceed with this payment under the owner's policy?",
  "proceed": true, "verdict": "ALLOW_UNDER_POLICY", "support": 0.92, "band": "green",
  "results": [ { "id": "recipient-matches-policy",
    "question": "Does the recipient match an entry the owner approved?", "status": "PASS",
    "code": "RECIPIENT_MATCHES_POLICY", "evidence": "recipient matches an approved policy entry",
    "evidenceClass": "owner-policy",
    "reference": "consult/references/pay/recipient-matches-policy.md" } ],
  "advisory": true }
```

For a full DENY, row by row, read
[examples/walkthrough-deny.md](../../examples/walkthrough-deny.md).
