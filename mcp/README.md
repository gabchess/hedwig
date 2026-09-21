# @hedwig/mcp

A stdio MCP server exposing one tool, `consult`, backed by `@hedwig/consult`.
```sh
yarn consult:build && yarn mcp:build
HEDWIG_POLICY_FILE=/path/to/policy.json node mcp/dist/server.js
```
`consult` takes `{ "request": <payment request> }` and returns the same response `@hedwig/consult` returns: `proceed`, `band`, `verdict`, `support`, `results`, `floorIds`, `advisory: true`. `support` shows how much of the owner's checklist was proven and how strong the proof was; callers act on `proceed`. `results` lists the worst outcome first.
The policy file is a regular JSON file of at most 256 KB; when a key appears twice, the last one applies.
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
