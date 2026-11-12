import { expect } from "chai";

import { parseExpertRequest } from "../src/expert-request";

const pair = [
  { chainId: 1, address: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" },
  { chainId: 1, address: "0xc3d688B66703497DAA19211EEdff47f25384cdc3" },
];

describe("expert request identity boundary", () => {
  it("preserves ordinary educational requests and rejects authority/config overrides", () => {
    expect(
      parseExpertRequest({ question: "Explain liquidation risk." })
    ).to.deep.equal({
      status: "ready",
      mode: "learn",
      question: "Explain liquidation risk.",
    });
    for (const value of [
      { question: "x", provider: "evil" },
      { question: "x", policy: {} },
      { question: "x", mode: "execute" },
      { question: "x", mode: null },
      { question: "x", mode: "learn", deployments: pair },
      { question: " " },
      { question: "x".repeat(4001) },
    ])
      expect(parseExpertRequest(value).status).to.equal("invalid_question");
  });

  it("resolves the exact chain/address pair independent of address case and order", () => {
    const result = parseExpertRequest({
      question: "Compare Aave V3 and Compound III on Ethereum.",
      mode: "compare",
      deployments: [...pair]
        .reverse()
        .map((d) => ({ ...d, address: d.address.toLowerCase() })),
    });
    expect(result?.status).to.equal("ready");
    if (result.status !== "ready" || result.mode !== "compare")
      throw new Error("expected comparison");
    expect(result.deployments.map((d) => d.chainId)).to.deep.equal([1, 1]);
    expect(result.deployments.map((d) => d.id)).to.deep.equal([
      "compound-iii-ethereum-usdc",
      "aave-v3-ethereum",
    ]);
    expect(
      result.deployments.every((d) => d.sourceFileUrl.includes("/blob/"))
    ).to.equal(true);
  });

  it("requires clarification for missing, unknown, duplicated or conflicting identities", () => {
    for (const value of [
      { question: "Compare these pools.", mode: "compare" },
      {
        question: "Compare Aave and Compound on Base.",
        mode: "compare",
        deployments: pair,
      },
      {
        question: "Compare these pools.",
        mode: "compare",
        deployments: [pair[0], pair[0]],
      },
      {
        question: "Compare these pools.",
        mode: "compare",
        deployments: [pair[0], { ...pair[1], chainId: 8453 }],
      },
      {
        question:
          "Compare 0x1111111111111111111111111111111111111111 against Aave.",
        mode: "compare",
        deployments: pair,
      },
    ]) {
      const result = parseExpertRequest(value);
      expect(result?.status).to.equal("needs_clarification");
      if (result.status !== "needs_clarification")
        throw new Error("expected clarification");
      expect(result.supportedDeployments).to.have.length(2);
      expect(result).not.to.have.property("answer");
    }
  });

  it("detects recognized chain, version and market contradictions without rejecting collateral terms", () => {
    const request = (question: string) =>
      parseExpertRequest({ question, mode: "compare", deployments: pair });
    for (const question of [
      "Compare Aave V3 and Compound III, but treat both as Base deployments.",
      "Compare these Base deployments",
      "Compare on the Base network",
      "Compare on chain 8453",
      "Compare on BNB Chain",
      "Compare Aave V2 with Compound III on Ethereum",
      "Compare Aave V3 with Compound v2 on Ethereum",
      "Compare Aave V3 with Compound III WETH Comet on Ethereum",
      "Compare 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E200 with Compound",
    ])
      expect(request(question)?.status, question).to.equal(
        "needs_clarification"
      );
    for (const question of [
      "Compare why Compound III uses a base asset",
      "Compare WETH collateral in these two supported deployments",
      "Compare these deployments on Ethereum mainnet, excluding Base",
    ])
      expect(request(question)?.status, question).to.equal("ready");
  });

  it("rejects malformed identity fields instead of normalizing them into authority", () => {
    for (const deployments of [
      "1:pool",
      [pair[0]],
      [...pair, pair[0]],
      [{ ...pair[0], chainId: "1" }, pair[1]],
      [{ ...pair[0], url: "https://example.com" }, pair[1]],
    ]) {
      expect(
        parseExpertRequest({
          question: "Compare",
          mode: "compare",
          deployments,
        }).status
      ).to.equal("invalid_question");
    }
  });

  it("distinguishes a base-asset role from an explicit Base deployment", () => {
    const request = (question: string) =>
      parseExpertRequest({ question, mode: "compare", deployments: pair });
    for (const question of [
      "Compare why Compound III uses USDC as the base asset with Aave V3",
      "Compare Compound III USDC and Aave V3 on Ethereum; USDC serves as base asset in Comet.",
      "Compare USDC AS THE BASE ASSET in Compound III with Aave V3.",
    ])
      expect(request(question).status, question).to.equal("ready");
    for (const question of [
      "Compare Aave V3 and Compound III, but treat both as Base deployments.",
      "Compare Aave V3 and Compound III, but treat both as Base.",
      "Compare Aave V3 and Compound III on Base.",
      "Compare USDC as the base asset on Base with Aave V3.",
      "Compare USDC as the base asset in Compound III with Aave V2.",
    ])
      expect(request(question).status, question).to.equal(
        "needs_clarification"
      );
  });
});
