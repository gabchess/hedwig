import { expect } from "chai";

import { consult } from "../src";
import {
  ASSET_ADDRESS,
  ASSET_SYMBOL,
  WETH_ADDRESS,
  makePolicy,
  makeRequest,
  makeSwapFacts,
  makeSwapPolicy,
  makeSwapRequest,
} from "./fixtures";

// A cap is a raw base-unit number. USDC has 6 decimals and WETH has 18, so a
// cap written for 5 WETH (5e18) is a different quantity from 5e18 base units
// of USDC. The Check compares a cap only with an amount of its own asset.
const FIVE_WETH = "5000000000000000000";

function amountCheck(response: ReturnType<typeof consult>) {
  const result = response.results.find((r) => r.id === "amount-within-cap");
  expect(result, "amount-within-cap result").to.not.equal(undefined);
  return result!;
}

function pay(
  amount: string,
  cap: string,
  capAsset: string | undefined,
  actionOverrides: Record<string, unknown> = {}
) {
  const base = makeRequest();
  return consult(
    makeRequest({ action: { ...base.action, amount, ...actionOverrides } }),
    makePolicy({
      perActionCaps: { pay: cap },
      perActionCapAssets: capAsset === undefined ? {} : { pay: capAsset },
    })
  );
}

function swap(
  amountIn: string,
  cap: string,
  capAsset: string | undefined,
  actionOverrides: Record<string, unknown> = {}
) {
  const base = makeSwapRequest();
  return consult(
    makeSwapRequest({
      action: {
        ...base.action,
        amountIn,
        approvalAmount: amountIn,
        ...actionOverrides,
      },
    }),
    makeSwapPolicy({
      perActionCaps: { pay: "1", swap: cap },
      perActionCapAssets: capAsset === undefined ? {} : { swap: capAsset },
    }),
    makeSwapFacts() as never
  );
}

describe("amount-within-cap: the cap names its asset (pay)", () => {
  it("never allows a USDC amount against a cap written for 5 WETH", () => {
    const response = pay(FIVE_WETH, FIVE_WETH, WETH_ADDRESS);

    expect(response.verdict).to.equal("UNKNOWN");
    expect(response.proceed).to.equal(false);
    expect(amountCheck(response)).to.include({
      status: "UNVERIFIED",
      code: "CAP_ASSET_MISMATCH",
    });
  });

  it("answers UNKNOWN for a cross-asset amount far below the raw cap number", () => {
    const response = pay("1", FIVE_WETH, WETH_ADDRESS);

    expect(response.verdict).to.equal("UNKNOWN");
    expect(amountCheck(response).status).to.equal("UNVERIFIED");
  });

  it("passes a same-asset amount below the cap", () => {
    const response = pay("999999", "1000000", ASSET_ADDRESS);

    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(amountCheck(response)).to.include({
      status: "PASS",
      code: "AMOUNT_WITHIN_CAP",
    });
  });

  it("passes a same-asset amount exactly at the cap", () => {
    const response = pay("1000000", "1000000", ASSET_ADDRESS);

    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(amountCheck(response)).to.include({
      status: "PASS",
      evidence: "amount 1000000 is within the cap 1000000",
    });
  });

  it("denies a same-asset amount above the cap", () => {
    const response = pay("1000001", "1000000", ASSET_ADDRESS);

    expect(response.verdict).to.equal("DENY");
    expect(amountCheck(response)).to.include({
      status: "FAIL",
      code: "AMOUNT_EXCEEDS_CAP",
    });
  });

  it("matches the cap's asset without regard to address case", () => {
    const response = pay("1000000", "1000000", ASSET_ADDRESS.toLowerCase());

    expect(amountCheck(response).status).to.equal("PASS");
  });

  it("answers UNKNOWN when the request names no asset", () => {
    const response = pay("1000000", "1000000", ASSET_ADDRESS, {
      asset: undefined,
    });

    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
    expect(amountCheck(response)).to.include({
      status: "UNVERIFIED",
      code: "CAP_ASSET_UNRESOLVED",
    });
  });

  it("answers UNKNOWN when the request's asset address is malformed", () => {
    const response = pay("1000000", "1000000", ASSET_ADDRESS, {
      asset: { symbol: ASSET_SYMBOL, contractAddress: "0xnot-an-address" },
    });

    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
    expect(amountCheck(response)).to.include({
      status: "UNVERIFIED",
      code: "CAP_ASSET_UNRESOLVED",
    });
  });

  it("answers UNKNOWN when the cap names no asset", () => {
    const response = pay("1000000", "1000000", undefined);

    expect(response.verdict).to.equal("UNKNOWN");
    expect(amountCheck(response)).to.include({
      status: "UNVERIFIED",
      code: "CAP_ASSET_MISSING",
    });
  });

  it("answers UNVERIFIED for a malformed cap asset", () => {
    const response = pay("1000000", "1000000", "USDC");

    expect(response.verdict).to.equal("UNKNOWN");
    expect(amountCheck(response)).to.include({
      status: "UNVERIFIED",
      code: "AMOUNT_MALFORMED",
    });
  });

  it("still answers UNVERIFIED for a malformed cap before it looks at the asset", () => {
    const response = pay("1000000", "1e6", WETH_ADDRESS);

    expect(amountCheck(response)).to.include({
      status: "UNVERIFIED",
      code: "AMOUNT_MALFORMED",
    });
  });

  it("never reads a cap asset off the prototype chain", () => {
    const base = makeRequest();
    const response = consult(
      makeRequest({ action: { ...base.action, type: "pay" } }),
      makePolicy({
        perActionCaps: { pay: "1000000" },
        perActionCapAssets: Object.create({ pay: ASSET_ADDRESS }),
      })
    );

    expect(amountCheck(response).code).to.equal("CAP_ASSET_MISSING");
  });
});

describe("amount-within-cap: the cap names its asset (swap amountIn)", () => {
  it("never allows a USDC amountIn against a cap written for 5 WETH", () => {
    const response = swap(FIVE_WETH, FIVE_WETH, WETH_ADDRESS);

    expect(response.verdict).to.equal("UNKNOWN");
    expect(response.proceed).to.equal(false);
    expect(amountCheck(response)).to.include({
      status: "UNVERIFIED",
      code: "SWAP_CAP_ASSET_MISMATCH",
    });
  });

  it("reads the input token, not the output token", () => {
    const response = swap("1000000", "1000000", WETH_ADDRESS);

    expect(amountCheck(response).code).to.equal("SWAP_CAP_ASSET_MISMATCH");
  });

  it("passes a same-asset amountIn at the cap", () => {
    const response = swap("1000000", "1000000", ASSET_ADDRESS);

    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(amountCheck(response)).to.include({
      status: "PASS",
      code: "SWAP_AMOUNT_WITHIN_CAP",
    });
  });

  it("denies a same-asset amountIn above the cap", () => {
    const response = swap("1000001", "1000000", ASSET_ADDRESS);

    expect(response.verdict).to.equal("DENY");
    expect(amountCheck(response)).to.include({
      status: "FAIL",
      code: "SWAP_AMOUNT_EXCEEDS_CAP",
    });
  });

  it("answers UNKNOWN when the request names no input token", () => {
    const response = swap("1000000", "1000000", ASSET_ADDRESS, {
      tokenIn: undefined,
    });

    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
    expect(amountCheck(response)).to.include({
      status: "UNVERIFIED",
      code: "SWAP_CAP_ASSET_UNRESOLVED",
    });
  });

  it("answers UNKNOWN when the cap names no asset", () => {
    const response = swap("1000000", "1000000", undefined);

    expect(response.verdict).to.equal("UNKNOWN");
    expect(amountCheck(response)).to.include({
      status: "UNVERIFIED",
      code: "SWAP_CAP_ASSET_MISSING",
    });
  });
});
