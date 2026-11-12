# @hedwig/mcp

This local MCP server exposes the existing `consult` payment-policy checker and an opt-in experimental learning mode, `ask_hedwig`. The experimental learning mode retrieves a small reference set before an operator-configured model generates its answer. Your application controls signing and execution.

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

## Learning modes

The default seed profile recognizes four reviewed questions about ERC-4626 shares and x402 facilitator roles. It is not yet a general DeFi knowledge base. Other wording and unsupported questions return insufficient evidence; current yields, deployment safety and deposit recommendations are outside this source pack.

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

The operator configures `OPENROUTER_API_KEY` and `HEDWIG_OPENROUTER_MODEL` in the server process. Use a scoped key with an approved spending cap. Never put credentials in tool arguments or commit them. No model is selected automatically, and no fallback model is configured. Without both values, supported learning requests return unavailable. In the seed profile, unsupported questions stop before generation. In the foundations profile, the model assesses whether retrieved summaries support the question.

The adapter uses structured output and a bounded response. The standard generation policy has a 15-second deadline and completion limits of 1,024 tokens for the seed profile or 2,048 for foundations. An operator explicitly selecting `openai/gpt-5.1` gets low-effort reasoning, a 20-second deadline and a shared reasoning/output limit of 4,096 tokens. Selecting `openai/gpt-5.2` uses medium effort, a 30-second deadline and 6,144 shared tokens. Hidden reasoning is excluded from either response. These policies do not select or fall back to a model. A truncated completion returns unavailable. The adapter sends data-collection denial and requires zero-retention routing for non-free models. Free models may only receive public test inputs. This is an operator requirement: the server does not detect private content in a question. The question and retrieved summaries are sent to the configured provider. The reviewed questions and source notes are public; qualify provider retention and access before exposing the service to non-public inputs.

Before sending a request, the adapter measures the complete serialized UTF-8 body, including messages and output schema, and refuses requests above 65,536 bytes. It preserves whole selected evidence units and rejects overflow instead of silently truncating them. This is a request-byte budget, not a token estimate or a claim to meet a 12,000-token budget. The local profile deliberately uses this measured transport bound together with question/unit limits, the model's output cap and deadline. The evaluation spending guard separately reserves the selected model's full input-context cost; bytes do not replace that financial boundary.

An answered result includes answer text and source IDs/URLs. Citation validation proves that an ID was retrieved; it does not prove that every generated claim follows from the source. This learning mode has no transaction verdict and cannot approve a deposit.

Model-free tests exercise an injected generator and mocked provider responses. They do not establish real-model answer quality, latency, billing or provider availability. On 2026-11-11, a real SDK client called the built stdio server in education mode using `baidu/ernie-5.5-flash-preview:free`. The vault-shares question returned a cited answer in 1.8 seconds; an unsupported yield question returned insufficient evidence, and a consult call was rejected. Reported key usage did not change. This single public-prompt check does not establish general answer quality, future model availability, or installation in a host app.

## Foundations retrieval profile

Set `HEDWIG_MODE=education` and `HEDWIG_KNOWLEDGE_MODE=foundations` to use natural questions over the reviewed reference summaries. The default learning profile remains `seed`; unknown profile names refuse startup. The caller cannot change the profile, sources or model through tool arguments.

The expanded corpus covers Ethereum account and transaction concepts, Solana account ownership and transactions, ERC-4626 vault mechanics, lending and liquidation, AMM liquidity, stablecoin and bridge risks, and x402 v2 payments. It also contains a documented-mechanism comparison of Aave V3 Ethereum and Compound III Ethereum USDC. Source-derived summaries are complete evidence units for their stated claims; they are not the full text of every upstream document. Each source has an immutable revision, source-file URL and license record in [foundations.json](src/knowledge/foundations.json). [Source notices](src/knowledge/THIRD-PARTY-NOTICES.md) are also included in the distributed plugin.

The built-in source pack is checked against a canonical SHA-256 pinned in compiled code before indexing. Packaging checks both source and compiled assets. A changed pack requires a reviewed checksum update; whitespace and object-key order do not change its identity. This detects mismatched assets, not an attacker replacing both the code and data. Generic fixture retrievers retain their separate shape and provenance validation.

BM25 ranks up to nine matching chunks for a learning question. Comparison mode first resolves two exact deployment identities, requires their pinned identity evidence, then collects at most sixteen units: two identity records, six mechanism units per protocol and two shared-context units. Those shared slots let token, issuer, chain or bridge risks remain visible alongside protocol mechanics. Matching words do not prove that a whole question is answerable. The model must use only retrieved evidence and return answer text, citation IDs and unsupported parts. The server validates those fields and derives answered or partial itself. The per-request model schema restricts citations to retrieved IDs; a separate validator checks them again.

An explicitly unasked comparison side has an empty section, while both selected deployment identities remain in the response metadata. This avoids manufacturing an unrelated explanation or evidence gap. The model declares which sections were requested; structural validation enforces their shape, and independent answer review remains necessary to assess scope and source support. A token address clearly mentioned as an asset is distinct from a conflicting Pool or Comet selection.

| Status | Meaning |
| --- | --- |
| answered | The model supplied an answer and retrieved citations. |
| partial | The answer addresses supported parts; unsupportedParts lists remaining gaps. |
| insufficient_evidence | No answer is returned. Evidence was absent or the proposed answer failed validation. |
| needs_clarification | Comparison identities are missing, duplicated, unsupported or in recognized conflict with the question. |
| unavailable | Generation failed, the provider refused, the call was cancelled or no model was configured. |
| invalid_question | The input was empty, oversized or had unexpected arguments. |

For an answered or partial result, sources include id, title, URL, pinned revision and source-file URL. When generation is unavailable, availableSources retains reference metadata without claiming an answer. Structural validation checks citation membership and rejects unknown bracketed source IDs. It does not prove semantic support. This corpus has no current balances, yields, live endpoint status or verified current deployment state. Comparison metadata explicitly records repository snapshots and liveStateVerified=false. Mechanism code or an address-book record does not prove the implementation currently running behind a proxy, current configuration, or deposit safety.

Risk coverage is educational: lending exposure, rate and liquidation mechanics, token and bridge dependencies, administrative powers, upgrades, oracle-based valuation and withdrawal conditions. The pack contains no scoped audit reports or incident-history evidence for the named pair, no complete strategy dependency graph, and no current administrator, oracle, liquidity or account observations. Missing evidence is a gap to disclose, never evidence that a protocol has no incidents or is safe.

The public contract retains per-source revisions and comparison snapshot metadata. It does not provide a per-response run ID, a whole-corpus digest, structured claim cells or audience preferences. Operator evaluation receipts separately bind the whole corpus and implementation. The server does not retain question or answer histories; its ordinary diagnostics omit their contents. Client logs and deliberately saved public evaluation receipts remain operator-owned files, without an automatic seven-day deletion policy. These contract choices do not establish a service for private inputs or remote tenants.

Example call:

```json
{ "question": "Compare redeem and withdraw for someone leaving an ERC-4626 vault." }
```

On 2026-11-11, a repaired evaluation sample through the built stdio server produced nine answered, five insufficient-evidence and two partial results using a verified zero-price model route. Independent review found no material unsupported claims in those sixteen outputs. Earlier attempts returned unavailable on an account question, and a diagnostic answer had an invented inline citation and imprecise hash wording. The prompt and citation validation were repaired; the earlier availability failures remain unexplained. A further six questions were written before their outputs, including Portuguese explanations and an instruction-injection attempt. All six passed independent source review after an initial HTTP 429 and one cooldown retry. Across both successful samples, twelve answers, seven declines, and three partial responses matched expectations. Reported usage did not increase. These observations are small evaluation samples, not a reliability estimate or a host-app installation check.

The optional live runner `node mcp/test/foundations-live-eval.js` requires an operator-provided `OPENROUTER_API_KEY` and explicit `HEDWIG_OPENROUTER_MODEL`. By default it accepts only a route whose current catalog prices are zero and sends the repository's public evaluation questions. It stops on availability, transport, authentication, quota or protocol failures without retry. A positively identified provider refusal is recorded as an unanswered case while other distinct questions continue; it is never converted to an answer pass. It waits sixty seconds between free-route cases and one second between explicitly authorized paid cases; neither interval guarantees provider capacity. Build the MCP first. Save stdout outside the source tree if retaining a report. A free route may become unavailable; the runner never switches models or enables paid usage automatically. An explicitly authorized paid plan can instead use the evaluation-only spending guard. A disk ledger reserves a conservative maximum charge before each call, settles verified usage.cost, and blocks further calls if a charge is uncertain. Explicit plan amendments preserve all prior spending and the same total cap. Writes synchronize file content and, on POSIX, parent directory entries before dispatch; Node does not portably support directory synchronization on Windows, so sudden-power-loss persistence of directory metadata is not guaranteed there. Plan and ledger paths must be outside the repository; credentials never belong in either file. Use `--suite=transfer` (also `--suite=expert-transfer`) for the current sixteen expert transfer cases, or `--suite=account-repair` for six account probes repeated twice. The earlier six-case `foundations-transfer-eval.json` is preserved as historical evidence and is no longer an active suite: its out-of-corpus assumptions predate the expanded source pack. Use `--suite=review-v2` for current full qualification: the original 76 cases plus two exposed review regressions, with a versioned correction requiring both delegated-borrow allowance and debt-owner capacity checks in fh04. Original acceptance, final-holdout and repair fixtures remain historical records; their earlier exposure labels and fh04 oracle do not establish current qualification. `--suite=acceptance` still selects the original 16 glossary, 12 comparison and 12 adversarial cases. Only these checked-in public suites are accepted; arbitrary fixture paths are rejected. The reported key usage difference can include concurrent requests and does not attribute cost to this run. Reports bind the built server, prompt adapter, corpus, evaluator and fixture by SHA-256 and check those bytes again at completion. They retain only fixed provider and budget diagnostic codes and numeric HTTP statuses; budget refusals remain distinct from provider outages. A completed run and status matches are not semantic adjudication. Historical successful reports certify only their recorded revisions.

## Deployment comparison request

Comparison generation uses exactly two sections keyed by the selected deployment IDs. Each section may cite only that deployment's retrieved evidence and the shared context. The application validates both sections, adds the trusted labels and combines their sources and gaps. Missing sections, unknown identities and citations from the other deployment are rejected. A supported section with an explicit gap in the other yields `partial`; two explicit abstentions yield `insufficient_evidence`. This structural check cannot prove that every requested fact was covered or that each claim follows from a source.

Successful and partial comparison responses also include both pinned identity references in `sources`, even when the generated explanation cites only mechanism records. These identity references support the application's deployment metadata. They do not attest the current implementation behind either proxy.

In the foundations profile, use the following exact identities for the supported Ethereum mainnet comparison:

```json
{
  "question": "Compare the documented lending and liquidation mechanisms, without ranking current yields or safety.",
  "mode": "compare",
  "deployments": [
    { "chainId": 1, "address": "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" },
    { "chainId": 1, "address": "0xc3d688B66703497DAA19211EEdff47f25384cdc3" }
  ]
}
```

Omitting identities in comparison mode returns `needs_clarification` with the supported records before any generation. Caller fields cannot select a provider, corpus, URL to fetch, policy or trusted observation. The question is checked for recognized chain, version, market and address contradictions; this finite check is not a universal natural-language entity resolver. Comparison responses identify the selected snapshots and their evidence boundaries separately from generated prose.

Cancelling an MCP request propagates to the provider request and response body. The fixed provider deadline still applies. A missing education corpus cannot prevent the default consult-only server from starting; selecting a malformed foundations corpus fails startup.

## Durable live evaluation receipts

For a paid evaluation, set `HEDWIG_EVAL_REPORT_PATH` to a new absolute JSONL journal outside the repository, alongside the existing plan and ledger settings. It is optional for free evaluations. The runner creates the journal exclusively, holds its file descriptor, and appends a synced checkpoint before and after each case. It never replaces an earlier run. Each checkpoint records completed responses and the active case. The `readLatestReport` helper in `mcp/test/live-eval-report.js` reads the last complete record and ignores a truncated final line; parseability alone does not establish successful synchronization. A write or sync failure stops the runner with `receipt_unavailable`, disables further appends, and attempts to remove the unfinished record. If storage also prevents that rollback, readable bytes may include an uncommitted record: preserve the journal for independent recovery and do not use it alone to establish qualification. Tests cover process interruption and injected I/O failures, not arbitrary power-loss durability. Final stdout remains ordinary JSON. Keep shell redirection separate from the journal path so the shell does not create the file first.

Use `--suite=final-holdout` for the eight independently authored final questions. Keep a fresh first exposure separate from subsequent repair-validation runs. Source and fixture hashes bind each report; runtime or helper changes require a new evaluation record.

The [current 2026-11-12 qualification receipt](validation/expert-review-v2-2026-11-12.json) records the reviewed 38-source/56-unit candidate: 56 fresh real-MCP cases and 22 independently checked historical observations with unchanged inputs and current output validation. Of these 78 cases, 75 meet all recorded dimensions. Three misses remain: an unasked liquidation-detail gap makes `c11` partial; the provider refuses the mixed injection/education request `f06`; and `f09` misses the frozen decisive Aave source alternative despite a supported Portuguese explanation. The review observed no identity, authority, fabricated-reference or unsupported consequential-claim violation. These findings qualify this bounded experimental profile with disclosed limitations; they do not claim 78 new calls, an all-pass benchmark or future error-free answers.

Use `--suite=review-v2-delta` to replay the exact 54 changed original cases plus two exposed review regressions. The complete suite and original oracles remain available. The real bundled SDK/stdio smoke, corpus-integrity gate, request-byte measurement and disposable rollback bind the current package. Final-head Linux CI and substantive external review are separate publication checks. [The earlier receipt](validation/expert-2026-11-12.json) is preserved unchanged as historical evidence, including interrupted attempts, earlier failures and the superseded fh04 oracle; its current-candidate fields refer to its own earlier snapshot.

After a process interruption, preserve the ledger and lock before any recovery. The evaluation-only `recoverInterruptedReservation` helper requires the reviewed ledger integrity, request ID, lock fingerprint and confirmed-dead owner PID. It saves the original files, marks the unknown request as uncertain, and permanently counts its full reservation against the existing cap while allowing only the remainder to be used. It does not invent a verified charge, reset the allowance or automatically recover locks. A separate interrupted recovery stays blocked for operator review. Prospective ledger entries retain request timing and a bounded generation reference when the provider supplies one; missing cost still stops normal execution.

The spending guard now saves a valid `X-Generation-Id` header before reading the response body, so a body timeout or interruption can retain a reference for later verification. A conflicting body ID keeps the first reference, marks the receipt uncertain and stops further calls without applying its reported cost. Missing identifiers or cost remain unresolved; capturing an ID alone does not establish a charge.

A later explicit spending authorization can raise the existing total cap through the evaluation-only `extendBudgetCap` operation. It preserves every historical plan, charge and recovered unknown reservation, records the approval reference and predecessor integrity, and saves the original ledger plus intent and application receipts. The returned plan works only with that existing ledger; ordinary initialization retains its original ceiling. Old plans and stale callers stop after an extension. Catalog requalification validates the active ledger and authorization history without creating another allowance. Approval metadata records the operator's authorization evidence; the helper cannot grant consent. A failed commit or final receipt keeps the exclusion lock for inspection rather than enabling further calls.

The operator-only `reconcileBudgetEntry` helper can settle a uniquely matched, latest uncertain entry after the immutable cap-history prefix. It requires reviewed final provider metadata, exact receipt and attribution hashes, the expected ledger integrity and a customer charge no greater than the reservation. Receipt projections must use normalized JSON; unknown fields, duplicate keys, conflicting IDs, earlier recovered entries and repeated reconciliation are rejected. The helper preserves the original entry, predecessor integrity, audit backup and every other charge or reservation. It cannot authenticate a provider record or establish a unique match: the operator must verify those facts before invoking it. It makes no provider calls, changes no spending cap and retains the exclusion lock if commit completion is uncertain.

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
