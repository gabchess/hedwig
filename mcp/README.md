# @hedwig/mcp

A stdio MCP server exposing one tool, `consult`, backed by `@hedwig/consult`.
Run these from the repo root, with Node.js 22+ and Yarn. `mcp/test/fixtures/policy.json` is a policy file you can start with; pass its absolute path.
```sh
yarn install --frozen-lockfile
npm ci --ignore-scripts --prefix mcp
yarn consult:build && yarn mcp:build
HEDWIG_POLICY_FILE=/path/to/policy.json node mcp/dist/server.js
```
`consult` takes `{ "request": <payment or swap request> }` and returns the same response `@hedwig/consult` returns: `question`, `proceed`, `band`, `verdict`, `support`, `results`, `floorIds`, `advisory: true`. `support` shows how much of the owner's checklist was proven and how strong the proof was; callers act on `proceed`. `results` lists the worst outcome first. The server supplies the facts itself on every call: the current time, and the role fact when the policy requires a role. The tool takes only `request`, so a caller supplies neither.
The policy file is a regular JSON file of at most 256 KB; when a key appears twice, the last one applies.
The server hashes the policy file's exact bytes (sha256) when it starts and reads the file again on every call. If the bytes differ from the start, because the file was edited, replaced, or swapped for a symlink to other content, `consult` answers `UNKNOWN` with the code `ADAPTER_POLICY_CHANGED` and writes one line to stderr naming `HEDWIG_POLICY_FILE`. If the file was deleted or cannot be read, the code is `ADAPTER_POLICY_UNREADABLE`. A file that could not be read at start is not picked up later. Restart the server to accept a new policy.
A `pay` policy states the owner's authorization-window choice. Without an `authorizationWindow` field, that row answers UNVERIFIED and `proceed` stays false.
A policy requiring a Solana role reads it through `HEDWIG_SOLANA_RPC_URL_DEVNET` / `_MAINNET` and `HEDWIG_SOLANA_FEE_PAYER_DEVNET` / `_MAINNET`, one pair per cluster. Without the pair set for the cluster a policy names, that role check answers UNVERIFIED. The policy's `role.member` field is optional: the server derives the member address itself from `role` and `holder`.
Add it to your MCP client as a stdio server. Use absolute paths in `args` (for `server.js`) and in `HEDWIG_POLICY_FILE`: a relative path resolves against the client's working directory, not this repo.
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
