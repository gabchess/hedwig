import { expect } from "chai";
import { consult } from "../src";
import { runTriggerGuard } from "../src/guard";
import { runTriggerGuardWith } from "../src/guard-internal";
import type { ConsultRequest, EvmCallProposal } from "../src";
import nativeFixture from "./fixtures/monad-router02.json";
import {
  APPROVED_RECIPIENT,
  ASSET_ADDRESS,
  UNAPPROVED_RECIPIENT,
  makePolicy,
  makeRequest,
  makeSwapFacts,
  makeSwapPolicy,
  makeSwapRequest,
} from "./fixtures";

// ERC-20 transfer(address,uint256), independently assembled from its ABI.
const transfer = (recipient = APPROVED_RECIPIENT, amount = 1_000_000n) =>
  "0xa9059cbb" +
  recipient.slice(2).padStart(64, "0") +
  amount.toString(16).padStart(64, "0");
const proposal = (): EvmCallProposal => ({
  from: APPROVED_RECIPIENT,
  to: ASSET_ADDRESS,
  value: "0",
  data: transfer(),
});
const request = (): ConsultRequest => makeRequest({ transaction: proposal() });
const binding = (result: ReturnType<typeof consult>) =>
  result.results.find((row) => row.id === "transaction-matches-intent");
const digest = (result: ReturnType<typeof consult>): unknown =>
  (result as unknown as { callDigest?: string }).callDigest;

// Literal receipt for the ABI fixture above. No expectation uses the binder
// under test. The sink below records a handoff only; it cannot sign or broadcast.
const checkedTransfer = {
  action: {
    type: "pay",
    chainId: "eip155:1",
    recipient: "0x00000000000000000000000000000000a11ce001",
    asset: {
      symbol: "USDC",
      contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    },
    amount: "1000000",
    target: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  chainId: "eip155:1",
  transaction: {
    from: "0x00000000000000000000000000000000a11ce001",
    to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    value: "0",
    data: "0xa9059cbb00000000000000000000000000000000000000000000000000000000a11ce00100000000000000000000000000000000000000000000000000000000000f4240",
  },
  callDigest:
    "sha256:92af1cdcfedf1f7f0d61c703a9a9ea9df47135326534519a396efbd3be44b00b",
};

describe("EVM call binding", () => {
  it("denies a transfer whose bytes send to an unapproved recipient", () => {
    const input = request();
    input.transaction!.data = transfer(UNAPPROVED_RECIPIENT);
    const result = consult(input, makePolicy());
    expect(result.verdict).to.equal("DENY");
    expect(binding(result)?.status).to.equal("FAIL");
    expect(digest(result)).to.equal(undefined);
  });

  it("requires transaction bytes even when no extra conditions are requested", () => {
    const result = consult(
      makeRequest({ transaction: undefined, conditions: [] }),
      makePolicy()
    );
    expect(result.verdict).to.equal("UNKNOWN");
    expect(result.proceed).to.equal(false);
    expect(binding(result)?.status).to.equal("UNVERIFIED");
  });

  it("refuses an undecoded Universal Router swap", () => {
    const input = makeSwapRequest();
    input.transaction = { ...proposal(), to: input.action.target!, data: "0x" };
    const result = consult(input, makeSwapPolicy(), makeSwapFacts());
    expect(result.verdict).to.equal("UNKNOWN");
    expect(result.proceed).to.equal(false);
    expect(binding(result)?.status).to.equal("UNVERIFIED");
  });

  for (const tokenIn of ["MON", 1, true]) {
    it(`preserves a slippage denial with primitive tokenIn ${JSON.stringify(
      tokenIn
    )}`, () => {
      const input = makeSwapRequest();
      input.action.chainId = "eip155:143";
      input.action.tokenIn = tokenIn as never;
      input.action.minOut = "0";
      input.transaction = proposal();
      const result = consult(input, makeSwapPolicy(), makeSwapFacts());
      expect(result.verdict).to.equal("DENY");
      expect(result.proceed).to.equal(false);
      expect(
        result.results.find((row) => row.id === "slippage-within-ceiling")?.code
      ).to.equal("SLIPPAGE_MIN_OUT_ZERO");
      expect(binding(result)?.status).to.equal("UNVERIFIED");
      expect(digest(result)).to.equal(undefined);
    });
  }

  it("allows a bound direct transfer and returns a call-only digest", () => {
    const result = consult(request(), makePolicy());
    expect(result.proceed).to.equal(true);
    expect(binding(result)?.status).to.equal("PASS");
    expect(digest(result)).to.equal(
      "sha256:92af1cdcfedf1f7f0d61c703a9a9ea9df47135326534519a396efbd3be44b00b"
    );
    expect(result.advisory).to.equal(true);
  });

  for (const [name, mutate] of [
    [
      "amount",
      (tx: EvmCallProposal) => {
        tx.data = transfer(APPROVED_RECIPIENT, 1n);
      },
    ],
    [
      "target",
      (tx: EvmCallProposal) => {
        tx.to = UNAPPROVED_RECIPIENT;
      },
    ],
    [
      "native value",
      (tx: EvmCallProposal) => {
        tx.value = "1";
      },
    ],
  ] as const) {
    it(`denies a decoded transfer with mismatched ${name}`, () => {
      const input = request();
      mutate(input.transaction!);
      const result = consult(input, makePolicy());
      expect(result.verdict).to.equal("DENY");
      expect(binding(result)?.status).to.equal("FAIL");
    });
  }

  for (const [name, patch] of [
    ["unknown selector", { data: "0x095ea7b3" + transfer().slice(10) }],
    ["trailing bytes", { data: transfer() + "00" }],
    [
      "address padding",
      { data: transfer().slice(0, 10) + "1" + transfer().slice(11) },
    ],
    ["odd hex", { data: transfer().slice(0, -1) }],
    ["noncanonical value", { value: "00" }],
    ["out-of-range value", { value: (1n << 256n).toString() }],
    ["zero sender", { from: "0x" + "0".repeat(40) }],
    ["extra nonce", { nonce: 0 }],
    ["signed transaction", { signedTransaction: "0x01" }],
  ] as const) {
    it(`refuses ${name} without an intent-only fallback`, () => {
      const result = consult(
        makeRequest({ transaction: { ...proposal(), ...patch } }),
        makePolicy()
      );
      expect(result.proceed).to.equal(false);
      expect(binding(result)?.status).to.equal("UNVERIFIED");
      expect(digest(result)).to.equal(undefined);
    });
  }

  it("cannot satisfy required EIP-3009 expiry with direct transfer bytes", () => {
    const input = request();
    input.action.validBefore = 2_000_000_300;
    const result = consult(
      input,
      makePolicy({
        authorizationWindow: { mode: "required", maxSeconds: 600 },
      }),
      { now: 2_000_000_000 }
    );
    expect(result.proceed).to.equal(false);
    expect(binding(result)?.status).to.equal("UNVERIFIED");
  });

  it("normalizes hex case and key order in the digest", () => {
    const input = request();
    const tx = input.transaction!;
    const upper = (value: string) => "0x" + value.slice(2).toUpperCase();
    input.transaction = {
      data: upper(tx.data),
      value: tx.value,
      to: upper(tx.to),
      from: upper(tx.from),
    };
    const actual = digest(consult(input, makePolicy()));
    expect(actual).to.be.a("string");
    expect(actual).to.equal(digest(consult(request(), makePolicy())));
  });

  it("binds the sender account into the digest", () => {
    const input = request();
    input.transaction!.from = UNAPPROVED_RECIPIENT;
    const actual = digest(consult(input, makePolicy()));
    expect(actual).to.be.a("string");
    expect(actual).not.to.equal(digest(consult(request(), makePolicy())));
  });

  it("changes the digest when the checked chain changes", () => {
    const input = request();
    input.action.chainId = "eip155:8453";
    const actual = digest(
      consult(input, makePolicy({ chainId: "eip155:8453" }))
    );
    expect(actual).to.be.a("string");
    expect(actual).not.to.equal(digest(consult(request(), makePolicy())));
  });

  it("changes the digest when transfer calldata and matching intent change", () => {
    const input = request();
    input.action.amount = "999999";
    input.transaction!.data = transfer(APPROVED_RECIPIENT, 999999n);
    const result = consult(input, makePolicy());
    expect(result.proceed).to.equal(true);
    expect(digest(result)).not.to.equal(
      digest(consult(request(), makePolicy()))
    );
  });

  it("changes the digest for a changed native value with matching calldata and intent", () => {
    const expected = nativeFixture.expected;
    const input: ConsultRequest = {
      action: {
        ...makeSwapRequest().action,
        chainId: "eip155:143",
        target: "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900",
        tokenIn: { kind: "native", symbol: "MON" },
        tokenOut: { symbol: "USDC", contractAddress: expected.outputAddress },
        amountIn: expected.amountIn,
        minOut: expected.amountOutMinimum,
        recipient: expected.recipient,
        deadline: Number(expected.deadline),
        approvalAmount: "0",
      },
      transaction: {
        from: expected.recipient,
        to: "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900",
        value: expected.amountIn,
        data: nativeFixture.data,
      },
    };
    const before = digest(consult(input, makeSwapPolicy()));
    input.action.amountIn = input.transaction!.value = "10000000000000000001";
    const start = 2 + 328 * 2;
    input.transaction!.data =
      nativeFixture.data.slice(0, start) +
      10_000_000_000_000_000_001n.toString(16).padStart(64, "0") +
      nativeFixture.data.slice(start + 64);
    const after = digest(consult(input, makeSwapPolicy()));
    expect(before).to.equal(
      "sha256:a812f2d2feaa1ef38e07a9a555555afae842693d3dd8078eab4c527999675e91"
    );
    expect(after).to.be.a("string").and.not.equal(before);
  });

  it("does not treat a truthy malformed proceed as permission to sign", async () => {
    let calls = 0;
    const result = await runTriggerGuardWith(
      (input, policy) => ({
        ...consult(input, policy),
        proceed: "true" as unknown as boolean,
      }),
      {
        payment: request(),
        toRequest: (value) => value,
        policy: makePolicy(),
        signer: () => {
          calls++;
          return "fixture-only";
        },
      }
    );
    expect(calls).to.equal(0);
    expect(result.signerOutcome).to.equal("not-attempted");
  });

  it("returns UNKNOWN when a policy getter throws during guard binding", async () => {
    let reads = 0;
    let calls = 0;
    const policy = makePolicy();
    Object.defineProperty(policy, "authorizationWindow", {
      enumerable: true,
      get() {
        if (++reads > 1)
          throw new Error("policy changed after consult cloned it");
        return { mode: "not-required" };
      },
    });
    const result = await runTriggerGuard({
      payment: request(),
      toRequest: (value) => value,
      policy,
      signer: () => {
        calls++;
        return "fixture-only";
      },
    });
    expect(reads).to.equal(2);
    expect(calls).to.equal(0);
    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.proceed).to.equal(false);
    expect(result.consult.results[0].code).to.equal(
      "GUARD_CALL_BINDING_INVALID"
    );
    expect(result.signerOutcome).to.equal("not-attempted");
  });

  it("hands the guard signer the captured account, chain, bytes and digest", async () => {
    const input = request();
    const handoffs: unknown[] = [];
    const result = await runTriggerGuard({
      payment: input,
      toRequest: (value) => value,
      policy: makePolicy(),
      gather: async () => {
        await Promise.resolve();
        input.action.chainId = "eip155:8453";
        input.action.recipient = UNAPPROVED_RECIPIENT;
        input.action.asset!.contractAddress = UNAPPROVED_RECIPIENT;
        input.action.amount = "1";
        input.action.target = UNAPPROVED_RECIPIENT;
        input.transaction!.from = UNAPPROVED_RECIPIENT;
        input.transaction!.to = UNAPPROVED_RECIPIENT;
        input.transaction!.value = "1";
        input.transaction!.data = transfer(UNAPPROVED_RECIPIENT, 1n);
      },
      signer: (checked) => {
        handoffs.push(checked);
        return "fixture-only";
      },
    });
    expect(result.consult.proceed).to.equal(true);
    expect(result.signerOutcome).to.equal("settled");
    expect(handoffs).to.deep.equal([checkedTransfer]);
  });

  it("prevents callback writes to the checked fields before a local handoff", async () => {
    const handoffs: unknown[] = [];
    const writes: boolean[] = [];
    const result = await runTriggerGuard({
      payment: request(),
      toRequest: (value) => value,
      policy: makePolicy(),
      signer: (checked) => {
        for (const [field, value] of Object.entries({
          from: UNAPPROVED_RECIPIENT,
          to: UNAPPROVED_RECIPIENT,
          value: "1",
          data: transfer(UNAPPROVED_RECIPIENT),
        })) {
          writes.push(Reflect.set(checked.transaction, field, value));
        }
        writes.push(Reflect.set(checked, "chainId", "eip155:8453"));
        writes.push(
          Reflect.set(checked, "callDigest", "sha256:" + "0".repeat(64))
        );
        writes.push(
          Reflect.set(checked.action, "recipient", UNAPPROVED_RECIPIENT)
        );
        writes.push(
          Reflect.set(
            checked.action.asset!,
            "contractAddress",
            UNAPPROVED_RECIPIENT
          )
        );
        handoffs.push(checked);
        return "fixture-only";
      },
    });
    expect(result.signerOutcome).to.equal("settled");
    expect(writes).to.deep.equal([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(handoffs).to.deep.equal([checkedTransfer]);
  });

  // Removing the public guard's refusal branch would put a call in the sink.
  for (const [name, mutate, verdict] of [
    [
      "chain outside policy",
      (input: ConsultRequest) => {
        input.action.chainId = "eip155:8453";
      },
      "DENY",
    ],
    [
      "recipient bytes",
      (input: ConsultRequest) => {
        input.transaction!.data = transfer(UNAPPROVED_RECIPIENT);
      },
      "DENY",
    ],
    [
      "amount bytes",
      (input: ConsultRequest) => {
        input.transaction!.data = transfer(APPROVED_RECIPIENT, 1n);
      },
      "DENY",
    ],
    [
      "target",
      (input: ConsultRequest) => {
        input.transaction!.to = UNAPPROVED_RECIPIENT;
      },
      "DENY",
    ],
    [
      "native value",
      (input: ConsultRequest) => {
        input.transaction!.value = "1";
      },
      "DENY",
    ],
    [
      "approval call",
      (input: ConsultRequest) => {
        input.transaction!.data = "0x095ea7b3" + transfer().slice(10);
      },
      "UNKNOWN",
    ],
    [
      "missing transaction",
      (input: ConsultRequest) => {
        delete input.transaction;
      },
      "UNKNOWN",
    ],
  ] as const) {
    it(`hands off nothing for ${name}`, async () => {
      const input = request();
      mutate(input);
      const handoffs: unknown[] = [];
      const result = await runTriggerGuard({
        payment: input,
        toRequest: (value) => value,
        policy: makePolicy(),
        signer: (checked) => {
          handoffs.push(checked);
        },
      });
      expect(result.consult.verdict).to.equal(verdict);
      expect(result.consult.proceed).to.equal(false);
      expect(result.signerOutcome).to.equal("not-attempted");
      expect(handoffs).to.deep.equal([]);
    });
  }

  it("keeps intent-only calls stopped after the policy is disabled and restored", async () => {
    const handoffs: unknown[] = [];
    const policy = makePolicy();
    const attempt = (input: ConsultRequest) =>
      runTriggerGuard({
        payment: input,
        toRequest: (value) => value,
        policy,
        signer: (checked) => {
          handoffs.push(checked);
        },
      });
    expect((await attempt(request())).signerOutcome).to.equal("settled");

    // This is the existing library policy gate, not an integration kill switch.
    policy.permits = false;
    for (const input of [request(), makeRequest({ transaction: undefined })]) {
      const stopped = await attempt(input);
      expect(stopped.consult.proceed).to.equal(false);
      expect(stopped.signerOutcome).to.equal("not-attempted");
      expect(handoffs).to.deep.equal([checkedTransfer]);
    }

    policy.permits = true;
    const legacy = await attempt(makeRequest({ transaction: undefined }));
    expect(legacy.consult.proceed).to.equal(false);
    expect(legacy.signerOutcome).to.equal("not-attempted");
    expect(handoffs).to.deep.equal([checkedTransfer]);
    expect((await attempt(request())).signerOutcome).to.equal("settled");
    expect(handoffs).to.deep.equal([checkedTransfer, checkedTransfer]);
  });

  // The internal seam supplies a stale allow receipt so the guard's independent
  // digest recheck is exercised. This does not model a wallet's active account.
  for (const changed of ["sender", "chain", "calldata"] as const) {
    it(`rejects a stale receipt after a bound ${changed} change (test-only seam)`, async () => {
      const input = request();
      const policy = makePolicy();
      if (changed === "sender") input.transaction!.from = UNAPPROVED_RECIPIENT;
      if (changed === "chain") {
        input.action.chainId = policy.chainId = "eip155:8453";
        const baseUsdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
        input.action.asset!.contractAddress = baseUsdc;
        input.action.target = input.transaction!.to = baseUsdc;
        policy.perActionCapAssets = { pay: baseUsdc };
      }
      if (changed === "calldata") {
        input.action.amount = "999999";
        input.transaction!.data = transfer(APPROVED_RECIPIENT, 999999n);
      }
      expect(consult(input, policy).proceed).to.equal(true);
      const handoffs: unknown[] = [];
      const result = await runTriggerGuardWith(
        (captured, ownerPolicy) => ({
          ...consult(captured, ownerPolicy),
          callDigest: checkedTransfer.callDigest,
        }),
        {
          payment: input,
          toRequest: (value) => value,
          policy,
          signer: (checked) => {
            handoffs.push(checked);
          },
        }
      );
      expect(result.consult.results[0].code).to.equal(
        "GUARD_CALL_BINDING_INVALID"
      );
      expect(result.consult.proceed).to.equal(false);
      expect(result.signerOutcome).to.equal("not-attempted");
      expect(handoffs).to.deep.equal([]);
    });
  }

  for (const callDigest of [undefined, "sha256:" + "0".repeat(64)]) {
    it(`never invokes the signer with a ${
      callDigest ? "mismatched" : "missing"
    } call digest`, async () => {
      let calls = 0;
      const result = await runTriggerGuardWith(
        (input, policy) => ({ ...consult(input, policy), callDigest }),
        {
          payment: request(),
          toRequest: (value) => value,
          policy: makePolicy(),
          signer: () => {
            calls += 1;
            return "fixture-only";
          },
        }
      );
      expect(result.signerOutcome).to.equal("not-attempted");
      expect(result.consult.proceed).to.equal(false);
      expect(calls).to.equal(0);
    });
  }
});
