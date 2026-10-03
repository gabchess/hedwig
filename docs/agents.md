# Call Hedwig from an agent

Hedwig checks a `pay` or `swap` request against the owner's policy and
answers whether the agent should proceed. It runs on the owner's computer
as a stdio MCP server with one tool, `consult`. It never holds a key and
never signs. The agent, or the owner's own signer, does that, and only
after Hedwig answers `proceed: true`.

## Point an agent at Hedwig

Paste this line into an agent that can run commands on your computer:

```
Before you move money onchain for me, consult Hedwig. Open this exact link and follow its instructions: https://usehedwig.xyz/agents.md
```

The page it opens is the agent-facing copy of this guide. The agent asks
you before it installs anything. It shows you the policy, you save the file
yourself, and the agent never writes or edits it.

## Install

You need git, Node.js 22 or newer, and Yarn.

```sh
mkdir hedwig && cd ./hedwig && git init &&
git fetch --depth 1 https://github.com/gabchess/hedwig.git e85049bc7087f434fd732bb02e0e87ca57acd82c &&
git checkout FETCH_HEAD &&
yarn install --frozen-lockfile && npm ci --ignore-scripts --prefix mcp && yarn consult:build && yarn mcp:build
```

This fetches the exact commit published as v0.4.2, by its full hash, and
stops if any step fails. A wrong hash fails at the fetch, before the
install runs. If a step fails, stop and fix the error before you run
anything else. If an earlier attempt left a `hedwig` folder, ask your
owner, and delete it only after they say yes. Delete only the `hedwig`
folder in the directory where you ran these commands.

The server reads the owner's policy from the file named in
`HEDWIG_POLICY_FILE`. It refuses to start without it. To try it, point it
at the example policy in `mcp/test/fixtures/policy.json`:

```sh
HEDWIG_POLICY_FILE=/path/to/policy.json node mcp/dist/server.js
```

## Register the server with your MCP client

Add Hedwig as a stdio server. Use absolute paths in `args` and in
`HEDWIG_POLICY_FILE`. A relative path resolves against the client's
working directory, not the repo.

```json
{
  "mcpServers": {
    "hedwig": {
      "command": "node",
      "args": ["/path/to/hedwig/mcp/dist/server.js"],
      "env": { "HEDWIG_POLICY_FILE": "/path/to/policy.json" }
    }
  }
}
```

## Write the policy

The policy is the owner's file. Keep it outside the repo. It's a JSON file,
and when a key appears twice, the last one applies. The server pins the file's bytes when it starts: `consult` answers `UNKNOWN` with `ADAPTER_POLICY_CHANGED` while the file's bytes differ from that start, and each restart pins whatever the file holds then, so review the file before a restart and keep it where the agent's OS user cannot write it. A deleted, unreadable or too-large file answers `UNKNOWN` with `ADAPTER_POLICY_UNREADABLE` instead. Both codes come with `proceed: false`. If `consult` answers either code, stop and tell your owner. Never restart the server or reconnect your MCP client to clear it.

```json
{
  "permits": true,
  "chainId": "eip155:1",
  "approvedRecipients": ["0x00000000000000000000000000000000a11ce001"],
  "perActionCaps": { "pay": "1000000" },
  "perActionCapAssets": { "pay": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  "role": { "mode": "not-required" },
  "authorizationWindow": { "mode": "not-required" }
}
```

| Field | Meaning |
|---|---|
| `permits` | Must be `true` for any answer to come back `ALLOW_UNDER_POLICY`. |
| `chainId` | The one chain the owner allows, as a CAIP-2 id such as `eip155:1` or `eip155:8453`. |
| `approvedRecipients` | Addresses the owner approved to receive a payment. |
| `perActionCaps` | The largest amount per action type, as a decimal string in the base units of the asset named in `perActionCapAssets`. |
| `perActionCapAssets` | The contract address of the asset each cap is written for, under the same action type. A cap applies only to an amount of that asset. A request for another asset, a request whose asset cannot be read, or a cap with no named asset answers `UNKNOWN`. For `swap`, the asset is `tokenIn`. |
| `role` | `{ "mode": "not-required" }`, or a Solana role the agent must hold. |
| `authorizationWindow` | For `pay`: `{ "mode": "not-required" }`, or `{ "mode": "required", "maxSeconds": n }` for an EIP-3009 authorization. |

A `swap` policy also reads `maxSlippageBps`, `maxDeadlineSeconds` and
`ownerAddresses`. A policy that leaves out `role`, or a `pay` policy that
leaves out `authorizationWindow`, answers `UNKNOWN`. The shapes for a required role and window are in
[consult/README.md](../consult/README.md).

A policy that requires a Solana role makes the server read that role over
the RPC named in `HEDWIG_SOLANA_RPC_URL_DEVNET` or `_MAINNET`, with the
matching `HEDWIG_SOLANA_FEE_PAYER_*`. The read uses no private key. Without that pair for the policy's cluster, the role check
answers `UNVERIFIED`. See [mcp/README.md](../mcp/README.md).

## Call `consult`

The tool takes one argument, `request`. The server reads the policy and
supplies the current time and any role fact itself. A caller can't pass a
policy or facts through the tool.

```json
{
  "request": {
    "action": {
      "type": "pay",
      "chainId": "eip155:1",
      "recipient": "0x00000000000000000000000000000000a11ce001",
      "asset": {
        "symbol": "USDC",
        "contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
      },
      "amount": "1000000",
      "target": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    }
  }
}
```

A `pay` action carries `chainId`, `recipient`, `asset`, `amount`, `target`
(the token contract the transaction calls) and, for an EIP-3009
authorization, `validBefore` in unix seconds. A `swap` action carries
`chainId`, `target` (the router), `tokenIn`, `tokenOut`, `amountIn`,
`quotedOut`, `minOut`, `slippageBps`, `deadline`, `recipient` and
`approvalAmount`. The swap example is in
[consult/README.md](../consult/README.md).

## Read the response

`consult` returns this shape, defined in
[consult/src/core.ts](../consult/src/core.ts):

| Field | What it holds |
|---|---|
| `question` | Fixed text for the action type. |
| `proceed` | `true` only when `verdict` is `ALLOW_UNDER_POLICY`. The one field to act on. |
| `verdict` | `ALLOW_UNDER_POLICY`, `DENY` or `UNKNOWN`. |
| `support` | A number from 0 to 1: how much of the checklist was proven and how strong the proof was. It never decides `verdict`. |
| `band` | `green`, `amber` or `red`, read from `support`. |
| `results` | One row per check, worst first: FAIL, then UNVERIFIED, then PASS. |
| `floorIds` | The mandatory checks that ran for this action type. |
| `advisory` | Always `true`. |

Each row in `results` carries `id`, `question`, `status`, `code`,
`evidence`, `evidenceClass` and `reference`, the path of the practice file
that explains the check.

## Act on the verdict

| `verdict` | When | What the agent does |
|---|---|---|
| `ALLOW_UNDER_POLICY` | Every mandatory check passed and the policy has `permits: true`. | Continue with the payment the owner asked for. |
| `DENY` | At least one check failed. `results[0]` is a FAIL. | Stop. Tell the owner `results[0].code` and `results[0].evidence`. |
| `UNKNOWN` | A check couldn't be completed, the policy doesn't permit, or the input was malformed. `PASS` rows can still appear, and can come first when every check passed. | Stop and ask the owner. Tell them the `code` and `evidence` of the first row whose `status` isn't `PASS`. If every row is `PASS`, tell them the policy doesn't permit the action. |

A server error still comes back as a normal response with `verdict:
"UNKNOWN"` and `proceed: false`, so one code path covers every answer.
Every call reads the policy file and the clock again, so a payment whose
terms changed gets checked on its new terms.

## Wrap a signer in code

If your agent signs in code, `runTriggerGuard` from `@hedwig/consult/guard`
runs the same check and calls your signer only when the verdict is
`ALLOW_UNDER_POLICY`. See the
[Trigger guard](../consult/README.md#trigger-guard).

## Safety

Hedwig never asks for a private key, a seed phrase, an API key or funds. A
Solana RPC URL from the owner's provider may contain a key. It stays in the
owner's local MCP config, and Hedwig never asks the agent for it. Its
only sources are `github.com/gabchess/hedwig` and `usehedwig.xyz`. A
Hedwig answer checks a payment against the owner's policy. The owner still
approves the payment itself.

[MCP server](../mcp/README.md) · [Payment check](../consult/README.md) ·
[Threat model](../THREAT-MODEL.md) · [Agent instructions](https://usehedwig.xyz/agents.md)
