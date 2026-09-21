# @hedwig/mcp

A stdio MCP server exposing one tool, `consult`, backed by `@hedwig/consult`.
```sh
yarn consult:build && yarn mcp:build
HEDWIG_POLICY_FILE=/path/to/policy.json node mcp/dist/server.js
```
`consult` takes `{ "request": <payment or swap request> }` and returns the same response `@hedwig/consult` returns: `proceed`, `band`, `verdict`, `support`, `results`, `floorIds`, `advisory: true`. `support` shows how much of the owner's checklist was proven and how strong the proof was; callers act on `proceed`. `results` lists the worst outcome first. The server supplies the facts itself on every call: the current time, and the role fact when the policy requires a role. The tool takes only `request`, so a caller supplies neither.
The policy file is a regular JSON file of at most 256 KB; when a key appears twice, the last one applies.
A policy requiring a Solana role reads it through `HEDWIG_SOLANA_RPC_URL_DEVNET` / `_MAINNET` and `HEDWIG_SOLANA_FEE_PAYER_DEVNET` / `_MAINNET`, one pair per cluster. Without the pair set for the cluster a policy names, that role check answers UNVERIFIED. The policy's `role.member` field is optional: the server derives the member address itself from `role` and `holder`.
Add it to your MCP client as a stdio server:
```json
{
  "mcpServers": {
    "hedwig": {
      "command": "node",
      "args": ["mcp/dist/server.js"],
      "env": { "HEDWIG_POLICY_FILE": "/path/to/policy.json" }
    }
  }
}
```
