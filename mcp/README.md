# @hedwig/mcp

This local MCP server exposes the existing `consult` payment-policy checker and an opt-in learning prototype, `ask_hedwig`. The learning prototype retrieves a small reference set before an operator-configured model generates its answer. Your application controls signing and execution.

## Run

Use Node.js 22+ and Yarn. From the repository root:

```sh
yarn install --frozen-lockfile --ignore-scripts
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

## Learning prototype

This branch implements a limited prototype. It recognizes four reviewed questions about ERC-4626 shares and x402 facilitator roles. It is not yet a general DeFi knowledge base. Other wording and unsupported questions return insufficient evidence; current yields, deployment safety and deposit recommendations are outside this source pack.

| HEDWIG_MODE | Exposed tools | Payment policy |
| --- | --- | --- |
| unset or consult | consult | Required and pinned at startup |
| education | ask_hedwig | Not required; consult calls rejected |
| both | consult and ask_hedwig | Required and pinned at startup |

A learning call has this shape:

```json
{ "question": "What are ERC-4626 vault shares?" }
```

The other reviewed questions are “What do ERC-4626 vault shares represent?”, “What is the facilitator role in x402?” and “What can an x402 V2 facilitator do?”. Capitalization, whitespace and a final question mark may vary.

The operator configures `OPENROUTER_API_KEY` and `HEDWIG_OPENROUTER_MODEL` in the server process. Use a scoped key with an approved spending cap. Never put credentials in tool arguments or commit them. No model is selected automatically, and no fallback model is configured. Without both values, supported learning requests return unavailable. Unsupported questions stop before generation.

The adapter uses structured output, a 15-second deadline and a bounded response. It sends data-collection denial and requires zero-retention routing for non-free models. Free models may only receive public or synthetic inputs. The current admitted questions and source notes are public. Operator configuration must be separately qualified before a live call.

An answered result includes answer text and source IDs/URLs. Citation validation proves that an ID was retrieved; it does not prove that every generated claim follows from the source. This prototype has no transaction verdict and cannot approve a deposit.

Model-free tests exercise an injected generator and mocked provider responses. They do not establish real-model answer quality, latency, billing or provider availability. On 2026-11-11, a real SDK client called the built stdio server in education mode using `baidu/ernie-5.5-flash-preview:free`. The vault-shares question returned a cited answer in 1.8 seconds; an unsupported yield question returned insufficient evidence, and a consult call was rejected. Reported key usage did not change. This single public-prompt check does not establish general answer quality, future model availability, or installation in a host app.

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

The [install guide](../docs/agents.md#register-the-server-with-your-mcp-client) shows the server config.
