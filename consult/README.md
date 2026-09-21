# consult

Checks a payment or swap request against the mandatory Floor Conditions and a Policy, then folds the results into one Verdict.

```ts
import { consult } from "@hedwig/consult";

const response = consult(request, policy);
// response.proceed: boolean, response.band: "green" | "amber" | "red"
// response.verdict: "ALLOW_UNDER_POLICY" | "DENY" | "UNKNOWN"
// response.support: 0..1
// response.results: [{ id, question, status, code, evidence, evidenceClass, reference }, ...]
// response.floorIds, response.advisory: true
```

`support` shows how much of the owner's checklist was proven and how strong the proof behind it was; it never decides `verdict`. Callers act on `proceed`. `results` lists the worst outcome first: FAIL, then UNVERIFIED, then PASS.

A pay or swap policy may also require a Solana role: `role: { mode: "not-required" }`, or `role: { mode: "required", cluster, programId, role, holder, maxAgeSeconds }`.

A swap request adds a third, optional argument, `facts`, the only place a clock ever enters: `consult(request, policy, { now })`. `pay` never reads it.

```ts
const swapResponse = consult(
  {
    action: {
      type: "swap",
      chainId: "eip155:1",
      target: "0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85",
      tokenIn: { symbol: "USDC", contractAddress: "0xA0b8..." },
      tokenOut: { symbol: "WETH", contractAddress: "0xC02a..." },
      amountIn: "1000000",
      quotedOut: "1000000",
      minOut: "995000",
      slippageBps: 50,
      deadline: 1_800_000_600,
      recipient: "0x...",
      approvalAmount: "1000000",
    },
  },
  policy,
  { now: 1_800_000_000 }
);
```

Run `yarn consult:typecheck` and `yarn consult:test`.
