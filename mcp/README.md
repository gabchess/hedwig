# @hedwig/mcp

A stdio MCP server exposing one tool, `consult`, backed by `@hedwig/consult`.
```sh
yarn consult:build && yarn mcp:build
HEDWIG_POLICY_FILE=/path/to/policy.json node mcp/dist/server.js
```
`consult` takes `{ "request": <payment request> }` and returns the same response `@hedwig/consult` returns: `verdict`, `results`, `floorIds`, `advisory: true`.
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
