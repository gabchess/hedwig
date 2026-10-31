# Hedwig evals

A fixed set of 57 labelled payment requests. Each one runs through `handleConsult`, the function behind the MCP server's `consult` tool, with a real policy file. The suite scores the verdict Hedwig returns. It calls no model and makes no network request.

## Result

Run on 2026-10-31 against Hedwig 0.5.1, Node v26.12.1. The full output is in [evals/results.json](evals/results.json).

| Category | Cases | Correct | Accuracy |
|---|---|---|---|
| Limits and edge amounts | 11 | 11 | 100% |
| Policy rules | 14 | 14 | 100% |
| Malformed requests | 17 | 17 | 100% |
| Prompt-injection-style requests | 12 | 12 | 100% |
| Swaps | 3 | 3 | 100% |
| Total | 57 | 57 | 100% |

- Wrong proceed: 0. No case whose label is not `ALLOW_UNDER_POLICY` came back with `proceed: true`. This is the safety number.
- Over-blocked: 0. No case labelled `ALLOW_UNDER_POLICY` was stopped.
- Runtime: 148 ms for 57 cases. Network calls: 0. Model calls: 0.

## Rerun it

Install the repo the way CI does, then run one command:

```sh
yarn install --frozen-lockfile --ignore-scripts && yarn consult:build && npm ci --ignore-scripts --prefix mcp
yarn evals
```

`yarn evals` prints one line per case and a summary, and rewrites `evals/results.json`. CI runs it on every push. A case that returns a verdict outside its label fails the build.

## What a verdict means here

Hedwig answers with one of three verdicts. The suite maps them to the usual names.

| Usual name | Hedwig verdict | What the agent does |
|---|---|---|
| allow | `ALLOW_UNDER_POLICY` | Signs the transaction it checked. |
| deny | `DENY` | Stops. A check failed. |
| escalate | `UNKNOWN` | Stops and asks the owner. A check could not be completed. |

## What the cases cover

- Limits. The cap exactly, one unit under and over, one base unit, 10^30, the largest uint256, 2^256, a 5 USDC cap and a zero cap.
- Policy rules. An unapproved recipient, an empty approved list, the wrong chain, `permits: false`, a missing `role`, `authorizationWindow`, cap or cap token, a payment in a different token than the cap, a lookalike token contract, a missing file, a file that is not JSON, and a key written twice.
- Malformed requests. Null or empty arguments, a sentence instead of a request, an unknown action type, amounts that are missing, numeric, negative, decimal or in exponent form, bad recipients, a chain id without the CAIP-2 prefix, a missing, cut or extended transaction, native value on a token transfer, and arguments over 64 KB.
- Prompt-injection-style requests. Free text in the action that claims the owner approved, a raised cap or a refund. A permissive policy or fake facts passed beside the request or inside it. An instruction in the token symbol. Calldata that pays another address, sends more, or calls another contract than the action says.
- Swaps. The consult README example, an unsupported router call and slippage over the ceiling.

## How the labels were made

An agent wrote every label from [docs/agents.md](docs/agents.md) and the check notes in [consult/references](consult/references) before the suite first ran. Each case cites the rule it comes from in its `basis` field. No label was copied from Hedwig's output.

A prompt-injection case carries the verdict of the same request without the injected text. Hedwig reads no free text, so the text must not change the answer.

Three cases (lim-11, pol-02, mal-17) accept either `DENY` or `UNKNOWN`. For those the docs say the answer is not allow, but they do not say which code wins.

To check that the suite can fail, a bug was planted in `mcp/src/handler.ts` that let a caller's own policy override the owner's file. The suite then scored 56 of 57, with 1 wrong proceed (inj-04). The bug was removed before this commit.

## Limits

- The labels come from Hedwig's own docs, written by an agent. No person and no second model reviewed them. 100% means Hedwig's behavior matches its docs on these 57 cases. It does not prove a payment is safe.
- Every case uses Ethereum USDC or the README swap. Solana roles, the signed token registry, live chain reads and Base are not covered.
- Each case is one deterministic call, so there is no sampling and no confidence interval.
- The suite does not test an agent. It tests the check an agent calls before it pays.

## Optional inspect-ai view

[evals/inspect_task.py](evals/inspect_task.py) runs the same cases with the same scoring under [inspect-ai](https://inspect.aisi.org.uk/). It runs the TypeScript suite once and scores each sample, with inspect's built-in mock model, so no model is called and no key is needed.

```sh
pip install inspect-ai
inspect eval evals/inspect_task.py --model mockllm/model
```

On 2026-10-31 it reported accuracy 1.000 overall and in each category, with inspect-ai 0.3.286. CI does not run it. A future task that calls a real model must be opt-in, must read its key from the environment, and must stay out of CI.

## How this was built

Agent-reported, not measured by a tool. One Claude Code agent (Claude Opus 5.5) built the suite on 2026-10-31. It took about 36 tool calls and 9 minutes of wall time from cloning the repo to the final passing run, before review and the pull request. No paid model call runs inside the suite. The agent's own token use was not measured.
