import { expect } from "chai";
import { consult } from "../src";
import { makeSwapPolicy, makeSwapRequest } from "./fixtures";
import fixture from "./fixtures/monad-router02.json";

const router = "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900";
const owner = fixture.expected.recipient;
const policy = makeSwapPolicy({
  chainId: "eip155:143",
  ownerAddresses: [owner],
});
const request = () => ({
  ...makeSwapRequest(),
  action: {
    ...makeSwapRequest().action,
    chainId: "eip155:143",
    target: router,
    tokenIn: { kind: "native" as const, symbol: "MON" as const },
    tokenOut: {
      symbol: "USDC",
      contractAddress: fixture.expected.outputAddress,
    },
    amountIn: "10000000000000000000",
    quotedOut: "10000000",
    minOut: "9950000",
    deadline: 1791320400,
    recipient: owner,
    approvalAmount: "0",
  },
  transaction: {
    from: owner,
    to: router,
    data: fixture.data,
    value: "10000000000000000000",
  },
});

describe("native Monad call binding (synthetic, no live facts)", () => {
  it("matching bytes alone cannot prove router or native-input safety", () => {
    const input = request();
    input.transaction.to = router.toUpperCase().replace("0X", "0x");
    const result = consult({ ...input, conditions: [] }, policy);
    expect(
      result.results.find((row) => row.id === "target-is-canonical")?.code
    ).to.equal("SWAP_TARGET_ROUTER_UNKNOWN");
    expect(
      result.results.find((row) => row.id === "token-in-is-canonical")?.status
    ).to.equal("UNVERIFIED");
    expect(result.proceed).to.equal(false);
  });

  it("a bound fake output still gets the issuer-backed denial", () => {
    const input = request();
    const fake = "77".repeat(20);
    input.action.tokenOut.contractAddress = `0x${fake}`;
    input.transaction.data =
      fixture.data.slice(0, 490) + fake + fixture.data.slice(530);
    const issuerSource = {
      origin: "circle.com",
      url: "https://developers.circle.com/stablecoins/usdc-contract-addresses",
      retrievedAt: 1791320000,
    };
    const result = consult(input, policy, {
      now: 1791320100,
      registryAsset: {
        chainId: "eip155:143",
        symbol: "USDC",
        contractAddress: fixture.expected.outputAddress,
        expiresAt: 1791320500,
        liveRead: "confirmed",
        liveReadAt: 1791320100,
        issuerSource,
      },
    });
    expect(
      result.results.find((row) => row.id === "target-is-canonical")?.code
    ).to.equal("SWAP_TARGET_ROUTER_UNKNOWN");
    const output = result.results.find(
      (row) => row.id === "token-out-is-canonical"
    );
    expect(output?.code).to.equal("SWAP_TOKEN_OUT_NOT_CANONICAL");
    expect(output?.canonicalAsset?.contractAddress).to.equal(
      fixture.expected.outputAddress
    );
    expect(output?.canonicalAsset?.issuerSource).to.deep.equal(issuerSource);
    expect(result.verdict).to.equal("DENY");
  });

  it("denies a proposal whose call sends a different native value", () => {
    const input = request();
    input.transaction.value = "1";
    const result = consult(input, policy);
    expect(
      result.results.find((row) => row.id === "target-is-canonical")?.code
    ).to.equal("MONAD_CALL_INTENT_MISMATCH");
    expect(result.verdict).to.equal("DENY");
    expect(result.proceed).to.equal(false);
  });

  it("binds every decoded call field to the declared intent", () => {
    const variants: Array<(input: ReturnType<typeof request>) => void> = [
      (input) => {
        input.transaction.to = owner;
      },
      (input) => {
        input.action.target = owner;
      },
      (input) => {
        input.transaction.to = owner;
        input.action.target = owner;
      },
      (input) => {
        input.transaction.from = router;
      },
      (input) => {
        input.action.recipient = router;
      },
      (input) => {
        input.action.amountIn = "1";
      },
      (input) => {
        input.action.tokenOut.contractAddress = router;
      },
      (input) => {
        input.action.minOut = "1";
      },
      (input) => {
        input.action.deadline += 1;
      },
      (input) => {
        input.action.approvalAmount = "1";
      },
    ];
    for (const mutate of variants) {
      const input = request();
      mutate(input);
      const result = consult(input, policy);
      expect(
        result.results.find((row) => row.id === "target-is-canonical")?.code
      ).to.equal("MONAD_CALL_INTENT_MISMATCH");
      expect(result.verdict).to.equal("DENY");
    }
  });

  it("refuses omitted, unsupported or signed proposal fields", () => {
    for (const tx of [
      undefined,
      null,
      {},
      [],
      { ...request().transaction, signedTransaction: "0xdeadbeef" },
      { ...request().transaction, nonce: 1 },
      { ...request().transaction, data: "0xdeadbeef" },
    ]) {
      const result = consult(
        { ...request(), transaction: tx } as never,
        policy
      );
      expect(
        result.results.find((row) => row.id === "target-is-canonical")?.code
      ).to.equal("MONAD_CALL_UNSUPPORTED");
      expect(result.proceed).to.equal(false);
    }
  });

  it("reports malformed fields as unavailable evidence instead of factual mismatches", () => {
    for (const path of [
      ["transaction", "from"],
      ["transaction", "to"],
      ["transaction", "value"],
      ["action", "target"],
      ["action", "recipient"],
      ["action", "amountIn"],
      ["action", "minOut"],
      ["action", "approvalAmount"],
      ["action", "deadline"],
    ]) {
      const input = request();
      (input as any)[path[0]][path[1]] = "bad";
      const result = consult(input, policy);
      const target = result.results.find(
        (row) => row.id === "target-is-canonical"
      );
      expect(target?.code, path.join(".")).to.equal("MONAD_CALL_UNSUPPORTED");
      expect(target?.status).to.equal("UNVERIFIED");
      expect(target?.evidenceClass).to.equal("not-verifiable");
    }
  });
});
