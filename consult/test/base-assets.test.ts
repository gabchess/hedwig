import { expect } from "chai";

import { consult } from "../src";
import {
  BASE_CHAIN_ID,
  BASE_USDC_ADDRESS,
  BASE_WETH_ADDRESS,
  CANONICAL_ASSET_ADDRESS,
  CANONICAL_ROUTERS,
  CANONICAL_WETH_ADDRESS,
} from "../src/catalog";
import {
  APPROVED_RECIPIENT,
  SWAP_NOW,
  makePolicy,
  makeRequest,
  makeSwapFacts,
  makeSwapPolicy,
  makeSwapRequest,
} from "./fixtures";

const basePay = (action: Record<string, unknown> = {}) =>
  makeRequest({
    action: {
      ...makeRequest().action,
      chainId: BASE_CHAIN_ID,
      asset: { symbol: "USDC", contractAddress: BASE_USDC_ADDRESS },
      target: BASE_USDC_ADDRESS,
      ...action,
    },
  });

const baseSwap = (action: Record<string, unknown> = {}) =>
  makeSwapRequest({
    action: {
      ...makeSwapRequest().action,
      chainId: BASE_CHAIN_ID,
      target: CANONICAL_ROUTERS[BASE_CHAIN_ID],
      tokenIn: { symbol: "USDC", contractAddress: BASE_USDC_ADDRESS },
      tokenOut: { symbol: "WETH", contractAddress: BASE_WETH_ADDRESS },
      ...action,
    },
  });

describe("Base assets", () => {
  it("a clean USDC pay on Base earns ALLOW at 0.92", () => {
    const response = consult(basePay(), makePolicy({ chainId: BASE_CHAIN_ID }));
    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(response.proceed).to.equal(true);
    expect(response.support).to.equal(0.92);
  });

  it("a clean USDC to WETH swap on Base earns ALLOW at 0.90", () => {
    const response = consult(
      baseSwap(),
      makeSwapPolicy({ chainId: BASE_CHAIN_ID }),
      makeSwapFacts()
    );
    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(response.support).to.equal(0.9);
  });

  it("the mainnet USDC address is not canonical on Base", () => {
    const response = consult(
      basePay({
        asset: { symbol: "USDC", contractAddress: CANONICAL_ASSET_ADDRESS },
        target: CANONICAL_ASSET_ADDRESS,
      }),
      makePolicy({ chainId: BASE_CHAIN_ID })
    );
    expect(response.verdict).to.equal("DENY");
    expect(
      response.results.find((r) => r.id === "asset-is-canonical")?.status
    ).to.equal("FAIL");
  });

  it("the Base USDC address is not canonical on mainnet", () => {
    const response = consult(
      makeRequest({
        action: {
          ...makeRequest().action,
          asset: { symbol: "USDC", contractAddress: BASE_USDC_ADDRESS },
          target: BASE_USDC_ADDRESS,
        },
      }),
      makePolicy()
    );
    expect(response.verdict).to.equal("DENY");
  });

  it("the Base WETH address is not the mainnet one", () => {
    expect(BASE_WETH_ADDRESS.toLowerCase()).to.not.equal(
      CANONICAL_WETH_ADDRESS.toLowerCase()
    );
    expect(BASE_USDC_ADDRESS.toLowerCase()).to.not.equal(
      CANONICAL_ASSET_ADDRESS.toLowerCase()
    );
    expect(BASE_USDC_ADDRESS.toLowerCase()).to.not.equal(
      APPROVED_RECIPIENT.toLowerCase()
    );
  });

  it("a Base pay whose target is the WETH contract is denied", () => {
    const response = consult(
      basePay({ target: BASE_WETH_ADDRESS }),
      makePolicy({ chainId: BASE_CHAIN_ID })
    );
    expect(response.verdict).to.equal("DENY");
    expect(
      response.results.find((r) => r.id === "target-is-canonical")?.status
    ).to.equal("FAIL");
  });

  it("a Base swap with a deadline in the past is denied, so facts still bind on Base", () => {
    const response = consult(
      baseSwap({ deadline: SWAP_NOW - 1 }),
      makeSwapPolicy({ chainId: BASE_CHAIN_ID }),
      makeSwapFacts()
    );
    expect(response.verdict).to.equal("DENY");
  });
});
