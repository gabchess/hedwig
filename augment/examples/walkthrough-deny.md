# Walkthrough: a poison-derived recipient, denied

The owner already approved this recipient once. A poison-transfer scan
later flagged the same address, so `recipient-not-poison-derived` catches
what `recipient-matches-policy` alone cannot: an address on the approved
list can still be one the owner would refuse.

## Request

```json
{
  "action": {
    "type": "pay",
    "chainId": "eip155:1",
    "recipient": "0x0000000000000000000000000000000000bad001",
    "asset": {
      "symbol": "USDC",
      "contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    },
    "amount": "1000000",
    "target": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
  }
}
```

## Policy

```json
{
  "permits": true,
  "chainId": "eip155:1",
  "approvedRecipients": ["0x0000000000000000000000000000000000bad001"],
  "perActionCaps": { "pay": "1000000" },
  "role": { "mode": "not-required" },
  "authorizationWindow": { "mode": "not-required" }
}
```

## Response

```json
{
  "question": "Should this agent proceed with this payment under the owner's policy?",
  "proceed": false,
  "verdict": "DENY",
  "support": 0,
  "band": "red",
  "results": [
    {
      "id": "recipient-not-poison-derived",
      "question": "Is the recipient free of any recorded poison transfer?",
      "status": "FAIL",
      "code": "RECIPIENT_POISON_DERIVED",
      "evidence": "recipient 0x0000000000000000000000000000000000bad001 was first seen through a poison transfer",
      "evidenceClass": "static-registry",
      "reference": "consult/references/pay/recipient-not-poison-derived.md"
    },
    {
      "id": "recipient-matches-policy",
      "question": "Does the recipient match an entry the owner approved?",
      "status": "PASS",
      "code": "RECIPIENT_MATCHES_POLICY",
      "evidence": "recipient matches an approved policy entry",
      "evidenceClass": "owner-policy",
      "reference": "consult/references/pay/recipient-matches-policy.md"
    },
    {
      "id": "asset-is-canonical",
      "question": "Does the asset contract match the canonical entry?",
      "status": "PASS",
      "code": "ASSET_IS_CANONICAL",
      "evidence": "asset contract matches the canonical entry",
      "evidenceClass": "static-registry",
      "reference": "consult/references/pay/asset-is-canonical.md"
    },
    {
      "id": "amount-within-cap",
      "question": "Is the amount above zero and within the owner's cap for this action?",
      "status": "PASS",
      "code": "AMOUNT_WITHIN_CAP",
      "evidence": "amount 1000000 is within the cap 1000000",
      "evidenceClass": "owner-policy",
      "reference": "consult/references/pay/amount-within-cap.md"
    },
    {
      "id": "chain-matches-intent",
      "question": "Does the request's chain match the owner's named chain?",
      "status": "PASS",
      "code": "CHAIN_MATCHES_INTENT",
      "evidence": "chain eip155:1 matches the owner's named chain",
      "evidenceClass": "owner-policy",
      "reference": "consult/references/pay/chain-matches-intent.md"
    },
    {
      "id": "target-is-canonical",
      "question": "Does the transaction call the canonical asset contract?",
      "status": "PASS",
      "code": "TARGET_IS_CANONICAL",
      "evidence": "target contract matches the canonical entry",
      "evidenceClass": "static-registry",
      "reference": "consult/references/pay/target-is-canonical.md"
    },
    {
      "id": "role-requirement-met",
      "question": "Is the owner's role requirement met?",
      "status": "PASS",
      "code": "ROLE_NOT_REQUIRED",
      "evidence": "owner policy requires no role",
      "evidenceClass": "owner-policy",
      "reference": "consult/references/pay/role-requirement-met.md"
    },
    {
      "id": "authorization-window-within-ceiling",
      "question": "Is the authorization's validBefore within the owner's maximum authorization window?",
      "status": "PASS",
      "code": "AUTHORIZATION_NOT_REQUIRED",
      "evidence": "owner policy requires no authorization window",
      "evidenceClass": "owner-policy",
      "reference": "consult/references/pay/authorization-window-within-ceiling.md"
    }
  ],
  "floorIds": [
    "recipient-matches-policy",
    "recipient-not-poison-derived",
    "asset-is-canonical",
    "amount-within-cap",
    "chain-matches-intent",
    "target-is-canonical",
    "role-requirement-met",
    "authorization-window-within-ceiling"
  ],
  "advisory": true
}
```

## Why each non-PASS row is what it is

- `recipient-not-poison-derived` FAILs with `RECIPIENT_POISON_DERIVED`:
  this exact address was first seen through a poison transfer, so it
  fails the check regardless of anything else in the request or policy.

Every other Floor row PASSes, including `recipient-matches-policy`: the
address is on the owner's approved list. One FAIL on any Floor row
outweighs every PASS, so `verdict` is `DENY`, `proceed` is `false`, and
`support` is `0`. An agent that acted on `recipient-matches-policy` alone
and skipped `recipient-not-poison-derived` would have signed this payment.
