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

Every policy states its choice about a Solana role: `role: { mode: "not-required" }`, or `role: { mode: "required", cluster, programId, role, holder, maxAgeSeconds }`. A policy with no `role` answers UNKNOWN.

A `pay` policy states the same choice about an EIP-3009 authorization window: `authorizationWindow: { mode: "not-required" }`, or `authorizationWindow: { mode: "required", maxSeconds }`.

The third, optional argument, `facts`, is the only place a clock or a chain observation enters: `consult(request, policy, { now, solanaRole })`. A swap reads `now` for its deadline; a required role reads `now` and `solanaRole`; a required authorization window reads `now`.

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

## Trigger guard

`@hedwig/consult/guard` exports `runTriggerGuard`. You pass it your payment and your signer. It runs `consult()` and calls your signer only when the Verdict is `ALLOW_UNDER_POLICY`.

```ts
import { runTriggerGuard } from "@hedwig/consult/guard";

const result = await runTriggerGuard({
  payment,
  toRequest: (payment) => ({ action: payment.action }),
  policy,
  gather: async (request) => ({ now: Math.floor(Date.now() / 1000) }),
  signer: (action) => mySigner(action),
});
// result.consult: the consult() response
// result.signerOutcome: "not-attempted" | "settled" | "unknown"
// result.signerResult: the signer's return value, when "settled"
```

`toRequest` maps your payment into a request. The guard turns that request into its own JSON snapshot once, then passes the same data to `gather`, `consult()` and your signer. Your signer receives its `action` field. The payment amount in that `action` is the same decimal string `consult()` checked. The frozen records have null prototypes: reading a field directly (`action.amount`) works, but use `Object.hasOwn(action, "amount")` instead of `action.hasOwnProperty("amount")`, which a null-prototype object does not have.

`gather` is optional and has `gatherDeadlineMs` to finish, 800 by default. A mapping error, a `gather` error or a missed `gather` deadline returns an `UNKNOWN` response with a `trigger-guard` row, and your signer is never called. Your signer has `signerDeadlineMs`, 5000 by default. Both deadlines must be a whole number of milliseconds from 1 to 2147483647; any other value fails closed with no gather or signer call. If the signer throws, rejects or misses its deadline, `signerOutcome` is `"unknown"` and the guard does not call it again, but a missed deadline does not stop the signer itself: it may still be running. An unknown `signerOutcome` means the signer may have acted or may still be acting; wait for the payment to reach a final state before signing again.

Run `yarn consult:typecheck` and `yarn consult:test`.
