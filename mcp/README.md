# @hedwig/mcp

A local stdio MCP server with one tool, `consult`, for checking payment and
swap proposals. This guide describes current `main`. The [agent install
guide](../docs/agents.md) pins the earlier v0.4.2 release.

## Run

Use Node.js 22+ and Yarn. From the repository root:

```sh
yarn install --frozen-lockfile
npm ci --ignore-scripts --prefix mcp
yarn consult:build && yarn mcp:build
HEDWIG_POLICY_FILE=/path/to/policy.json node mcp/dist/server.js
```

Start from [`mcp/test/fixtures/policy.json`](test/fixtures/policy.json), review
it and save your policy outside the repository. Pass its absolute path. On
current `main`, each cap needs a matching asset in `perActionCapAssets`. A
`pay` policy must also state its `authorizationWindow` choice. Missing fields
leave the relevant checks UNVERIFIED.

## Call and response

`consult` takes `{ "request": <payment or swap request> }`. The server reads
the policy and supplies the current time and any required role observation.
The caller cannot pass a policy or facts through the tool.

The response contains `question`, `proceed`, `band`, `verdict`, `support`,
`results`, `floorIds` and `advisory: true`. Act on `proceed`. The 0-to-1
`support` value describes the evidence behind the checks after the verdict
has been decided. Results list FAIL rows first, followed by UNVERIFIED and
PASS. See the [payment-check guide](../consult/README.md) for shapes and limits.

## Policy file

The policy must be a regular JSON file of at most 256 KB (262,144 bytes).
Duplicate keys use the last value. At startup, the server pins a SHA-256 hash
of the file's bytes and compares every later read against it.

| File state | Result |
| --- | --- |
| Bytes changed by an edit, replacement or symlink swap | `UNKNOWN` with `ADAPTER_POLICY_CHANGED`. |
| Deleted, unreadable, oversized, a directory or a FIFO | `UNKNOWN` with `ADAPTER_POLICY_UNREADABLE`. |
| Unreadable at startup | Every call in that process stays `ADAPTER_POLICY_UNREADABLE`, even after a repair. |
| Identical bytes, still readable | The policy is checked normally. |

A changed file also produces a stderr message naming `HEDWIG_POLICY_FILE`.
Every restart pins the file's current bytes without warning. Review the file
before restarting, or store it where the agent's OS user cannot write it.

## Chain observations

A required Solana role uses `HEDWIG_SOLANA_RPC_URL_DEVNET` and
`HEDWIG_SOLANA_FEE_PAYER_DEVNET`, or the corresponding `_MAINNET` pair. Missing
configuration leaves the role check UNVERIFIED. `role.member` is optional;
the server derives it from `role` and `holder`. Deployment evidence currently
covers devnet.

The registry reader currently accepts no entries because its two pinned
signing keys are empty. Configuration alone cannot activate it. The code can
verify signed token entries and collect vault observations, but the catalog
has no vault condition or `deposit` action. The public server also does not
collect unknown-token market signals or supply their thresholds.

The registry configuration is reserved for a release with usable signing keys:

| Variable | Purpose |
| --- | --- |
| `HEDWIG_REGISTRY_URL` | Host serving signed registry entries. |
| `HEDWIG_EVM_RPC_URL_<chain number>` | RPC used to confirm contract code on that EVM chain. |
| `HEDWIG_REGISTRY_RATCHET_FILE` | Saved highest sequence per entry, defaulting to `~/.hedwig/registry-ratchet.json`. |

An unconfirmed contract code hash cannot pass. The sequence file appends one
JSON line per increase so processes can share it. If writing fails, the
process retains its sequences in memory. A malformed line or missing final
newline causes admissions to be refused without updating their sequences.
Each caller must check the admission result. Persistently malformed data
requires owner repair; deleting the file resets the saved sequences.
While the keys remain empty, the server reads none of these variables.

## Register with a client

Use absolute paths for `server.js` and `HEDWIG_POLICY_FILE`. Relative paths
resolve against the client's working directory.

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
