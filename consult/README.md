# Payment and swap checks

`@hedwig/consult` checks a proposed payment or swap against the owner's policy and returns a decision with the result of each check. This guide describes the current `main` branch. The [agent install guide](../docs/agents.md) pins the earlier v0.4.2 release.

```ts
import { consult } from "@hedwig/consult";

const response = consult(request, policy);
// response.proceed: boolean, response.band: "green" | "amber" | "red"
// response.verdict: "ALLOW_UNDER_POLICY" | "DENY" | "UNKNOWN"
// response.support: 0..1
// response.results: [{ id, question, status, code, evidence, evidenceClass, reference }, ...]
// response.floorIds, response.advisory: true
```

Act on `proceed`. A failed check returns `DENY`; an incomplete check returns `UNKNOWN` unless another check has already failed. Both set `proceed: false`. An allow requires every mandatory check to pass and `policy.permits` to be `true`.

`support` is a number from 0 to 1, calculated after the verdict from the completed checks and their evidence. It describes checklist support, not a probability that a transaction is safe. `results` lists FAIL rows first, followed by UNVERIFIED and PASS.

## Policy and coverage

The current catalog supports `pay` and `swap`. Its built-in token and router addresses cover Ethereum and Base. Slippage checks use the supplied quote and minimum output; they do not read market prices or simulate a sandwich attack.

Each cap in `perActionCaps` must name its asset contract in `perActionCapAssets`. Amounts use that asset's base units. A missing or different cap asset returns UNVERIFIED for that check.

Every policy states its choice about a Solana role: `role: { mode: "not-required" }`, or `role: { mode: "required", cluster, programId, role, holder, maxAgeSeconds }`. A policy with no `role` answers UNKNOWN.

A `pay` policy states the same choice about an EIP-3009 authorization window: `authorizationWindow: { mode: "not-required" }`, or `authorizationWindow: { mode: "required", maxSeconds }`.

## Facts supplied by the integration

`consult()` makes no network call and reads no clock. Its optional third argument carries observations: `consult(request, policy, facts)`. The integration must collect and validate them.

| Fact | Use |
| --- | --- |
| `now` | Dates deadlines, authorization windows and observations. |
| `solanaRole` | Supplies the result of the required role check. |
| `registryAsset` | Supplies a signed-registry token entry whose signatures the reader has already verified. |
| `marketSignals` | Supplies fresh liquidity, holder and transfer data from the owner's RPC for an unknown pay asset. |
| `registryVault` | Holds vault observations for future checks; no current condition uses it. |

Unknown-asset market checks also require the service's threshold parameters. Missing readings or parameters return UNVERIFIED. Passing those checks alone cannot establish token identity. The public MCP server does not yet collect market signals or supply those parameters.

`facts.params` carries the service's domain constants. consult takes it out of `facts` before any Condition runs, so the bundle is never a value a Condition is handed: it reads one listed constant, labelled `check` or `both`, through `context.param`. This is not a sandbox. Code in the same process can still reach the bundle: it can patch a built-in or a module export, or read the heap through `node:inspector` or `node:v8`. consult does not defend against this. Do not alias the bundle: a reference to it under another key of `facts`, or kept elsewhere, is not taken out.

`consult()` trusts the integration to verify registry signatures. A registry token can pass only at its own address, with an unexpired entry and a confirmed chain read no older than 60 seconds. The public MCP reader currently ships with empty registry keys and accepts no registry entries.

## Local swap example

These fixed values show the request and policy shape. They are not a live quote.

```ts
import { consult, type Policy } from "@hedwig/consult";

const owner = "0x00000000000000000000000000000000a11ce001";
const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const swapPolicy: Policy = {
  permits: true,
  chainId: "eip155:1",
  approvedRecipients: [owner],
  perActionCaps: { swap: "1000000" },
  perActionCapAssets: { swap: usdc },
  maxSlippageBps: 100,
  maxDeadlineSeconds: 600,
  ownerAddresses: [owner],
  role: { mode: "not-required" },
};

const swapResponse = consult(
  {
    action: {
      type: "swap",
      chainId: "eip155:1",
      target: "0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85",
      tokenIn: { symbol: "USDC", contractAddress: usdc },
      tokenOut: {
        symbol: "WETH",
        contractAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      },
      amountIn: "1000000",
      quotedOut: "1000000",
      minOut: "995000",
      slippageBps: 50,
      deadline: 1_800_000_600,
      recipient: owner,
      approvalAmount: "1000000",
    },
  },
  swapPolicy,
  { now: 1_800_000_000 }
);
```

## Trigger guard

`@hedwig/consult/guard` exports `runTriggerGuard`. You pass it your payment and your signer. It runs `consult()` and calls that signer only when the verdict is `ALLOW_UNDER_POLICY`. This protects the path routed through the guard; a caller with another signing path can bypass it.

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

`gather` is optional and has `gatherDeadlineMs` to finish, 800 by default. A mapping error, a `gather` error or a missed `gather` deadline returns an `UNKNOWN` response with a `trigger-guard` row, and your signer is never called. Your signer has `signerDeadlineMs`, 5000 by default. Each deadline must be a whole number of milliseconds from 1 to 2147483647. An invalid `signerDeadlineMs` fails closed with no signer call. `gatherDeadlineMs` is only checked when `gather` is passed; an invalid value there fails closed with no gather call. If the signer throws, rejects or misses its deadline, `signerOutcome` is `"unknown"` and the guard does not call it again, but a missed deadline does not stop the signer itself: it may still be running. An unknown `signerOutcome` means the signer may have acted or may still be acting; wait for the payment to reach a final state before signing again.

Run `yarn consult:typecheck` and `yarn consult:test`.
