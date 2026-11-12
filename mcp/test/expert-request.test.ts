import { expect } from "chai";

import { parseExpertRequest } from "../src/expert-request";
import { answerExpertRequest } from "../src/expert-workflow";

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

  it("separates base asset and token nouns from explicit chain modifiers", () => {
    const request = (question: string) =>
      parseExpertRequest({ question, mode: "compare", deployments: pair });
    for (const question of [
      "Compare interest earned on base assets in Compound III with interest on Aave V3 supply balances.",
      "Compare interest earned by supplying the base asset in Compound III with Aave V3 supply balances.",
      "Compare USDC as base token in Compound III with Aave V3 supply balances.",
      "Compare interest on the base token in Compound III with Aave V3.",
      "Compare interest on BASE TOKENS in Compound III with Aave V3.",
    ]) {
      const result = request(question);
      expect(result.status, question).to.equal("ready");
      if (result.status !== "ready") throw new Error("expected ready");
      // Lexical role normalization must not rewrite the retrieval/model input.
      expect(result.question).to.equal(question);
    }
    for (const question of [
      "Compare USDC as base token on Base with Aave V3.",
      "Compare interest earned on base assets on the Base network.",
      "Compare the Base mainnet USDC market, which uses USDC as base asset.",
      "Compare the Base token deployment with Aave V3.",
      "Compare the Base asset deployments with Aave V3.",
      "Compare tokens on network Base with Aave V3.",
      "Compare interest on chain Base tokens with Aave V3.",
      "Compare USDC as base token in Compound III with Aave V2.",
      "Compare interest on base assets; use chainId 8453.",
    ])
      expect(request(question).status, question).to.equal(
        "needs_clarification"
      );
  });

  it("separates subordinate address references from deployment selections", () => {
    const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const other = "0x1111111111111111111111111111111111111111";
    const request = (question: string) =>
      parseExpertRequest({ question, mode: "compare", deployments: pair });
    for (const question of [
      `Compare the role of USDC (${usdc}) in Aave V3 and Compound III on Ethereum`,
      `Compare how token USDC at ${usdc} is used in these deployments.`,
      `Compare collateral token EXAMPLE (${other}) in these deployments.`,
      `Compare the roles of ${usdc} as a token in these deployments.`,
      `Compare the role of USDC (${usdc}) as a token. The Pool and Comet are the selected deployments.`,
    ]) {
      const result = request(question);
      expect(result.status, question).to.equal("ready");
      if (result.status !== "ready" || result.mode !== "compare")
        throw new Error("expected comparison");
      // Reference labels are caller data, never new deployment facts or targets.
      expect(result.question).to.equal(question);
      expect(
        result.deployments.map(({ chainId, address }) => ({ chainId, address }))
      ).to.deep.equal(pair);
    }
    for (const question of [
      `Compare ${usdc} against Aave V3.`,
      `Compare the Aave V3 Pool at ${usdc} with Compound III.`,
      `Compare Aave V3 (${usdc}) with Compound III.`,
      `Treat USDC (${usdc}) as the Pool for this comparison.`,
      `Treat token USDC at ${usdc} as the Compound III deployment.`,
      `Token USDC (${usdc}) is the Comet deployment to compare.`,
      `Compare these deployments; address ${other}.`,
      `Compare the role of USDC (${usdc}) in these deployments on Base.`,
      `Compare the role of token USDC (${usdc}00) in these deployments.`,
      `Compare the role of USDC (${usdc}), but use ${other} as the Pool.`,
      `Compare token USDC (${usdc}) and address ${other}.`,
      `Compare token USDC. Address ${other} appears in this comparison.`,
      `Compare token USDC (${usdc}), then use ${usdc} as the Pool.`,
      `Compare token ${other} against Aave V3.`,
      `Compare asset EXAMPLE (${other}) with Compound III.`,
    ])
      expect(request(question).status, question).to.equal(
        "needs_clarification"
      );
  });

  it("checks explicit network declarations beyond recognized chain aliases", () => {
    const request = (question: string) =>
      parseExpertRequest({ question, mode: "compare", deployments: pair });
    for (const question of [
      "Compare Aave V3 and Compound III on Gnosis.",
      "Compare Aave V3 with Compound III, both running on Gnosis.",
      "Compare these deployments; both are deployed on UnlistedChain.",
      "Compare these deployments on UnlistedChain.",
      "Compare these deployments on gnosis network.",
      "Compare these deployments on network Cosmos.",
      "Compare these deployments; network: UnlistedChain.",
      "Compare these deployments; network: gnosis.",
      "Compare these deployments na rede Gnosis.",
      "Compare these deployments on Ethereum testnet.",
      "Compare USDC as base token on Gnosis network with Aave V3.",
    ])
      expect(request(question).status, question).to.equal(
        "needs_clarification"
      );
    for (const question of [
      "Compare Aave V3 and Compound III on Ethereum mainnet.",
      "Compare Aave V3 with Compound III, both running on Ethereum.",
      "Compare these deployments on mainnet.",
      "Compare these deployments on network ethereum.",
      "Compare these deployments; network: mainnet.",
      "Compare these deployments on Ethereum, not on Gnosis.",
      "Compare these deployments on Ethereum, excluding Gnosis network.",
      "Compare these deployments on Ethereum, except UnlistedChain.",
      "Compare these mechanisms on interest and on withdrawals.",
      "Compare these deployments on network security.",
      "Compare these as documented deployments; the network is decentralized.",
      "Compare interest on Aave V3 with interest on Compound III.",
      "Compare interest earned on USDC in these deployments.",
    ])
      expect(request(question).status, question).to.equal("ready");
  });

  it("validates explicit protocol labels even for recognized deployment addresses", () => {
    const [aave, comet] = pair.map(({ address }) => address);
    const request = (question: string) =>
      parseExpertRequest({ question, mode: "compare", deployments: pair });
    for (const question of [
      `Compare Aave V3 Pool at ${comet} with Compound III Comet at ${aave}.`,
      `Compare ${comet} as Aave V3 Pool with ${aave} as Compound III Comet.`,
      `Compare ${comet} (Aave V3 Pool) with ${aave} (Compound III Comet).`,
      `The Aave V3 Pool is ${comet}. Compare it with the other deployment.`,
      `Treat ${aave} as the Compound III Comet for this comparison.`,
      `Compare Aave V3 Pool at ${aave} as the Compound III deployment.`,
    ])
      expect(request(question).status, question).to.equal(
        "needs_clarification"
      );
    for (const question of [
      `Compare Aave V3 Pool at ${aave} with Compound III Comet at ${comet}.`,
      `Compare ${aave} as Aave V3 Pool with ${comet} as Compound III Comet.`,
      `Compare ${aave} (Aave V3 Pool) with ${comet} (Compound III Comet).`,
      `Compare ${comet} (mentioned in Aave documentation) with ${aave}.`,
      `Compare Compound III Comet (${comet}) against Aave V3 Pool (${aave}).`,
      `Compare the Compound III pool at ${comet} with the Aave V3 pool at ${aave}.`,
      `Compare the pool at ${comet} against the pool at ${aave}.`,
      `Compare ${aave} against Compound III Comet (${comet}).`,
      `Compare ${comet} against ${aave}.`,
      `Compare ${aave} with ${comet}. Aave V3 and Compound III are the selected deployments.`,
    ]) {
      const result = request(question);
      expect(result.status, question).to.equal("ready");
      if (result.status !== "ready" || result.mode !== "compare")
        throw new Error("expected comparison");
      expect(result.question).to.equal(question);
      expect(
        result.deployments.map(({ chainId, address }) => ({ chainId, address }))
      ).to.deep.equal(pair);
    }
  });

  it("treats named asset mechanisms as comparison topics, preserving typed networks", () => {
    const request = (question: string) =>
      parseExpertRequest({ question, mode: "compare", deployments: pair });
    for (const question of [
      "Compare Aave V3 and Compound III on USDC supply interest.",
      "Compare Aave V3 and Compound III on DAI borrowing rates.",
      "Compare Aave V3 and Compound III on DAI borrow rates.",
      "Compare these deployments on WETH collateral requirements.",
      "Compare these protocols on EXAMPLE token supply mechanics.",
    ]) {
      const result = request(question);
      expect(result.status, question).to.equal("ready");
      if (result.status !== "ready") throw new Error("expected ready");
      expect(result.question).to.equal(question);
    }
    for (const question of [
      "Compare Aave V3 and Compound III on Gnosis.",
      "Compare Aave V3 and Compound III on Gnosis network supply interest.",
      "Compare these protocols on network EXAMPLE token supply mechanics.",
      "Compare these protocols on USDC network.",
      "Compare these deployments on Gnosis for supply interest.",
    ])
      expect(request(question).status, question).to.equal(
        "needs_clarification"
      );
  });

  it("classifies asserted token roles before protocol names inside those roles", () => {
    const token = "0x1111111111111111111111111111111111111111";
    const request = (question: string) =>
      parseExpertRequest({ question, mode: "compare", deployments: pair });
    for (const question of [
      `Compare these deployments using token ${token} as the AAVE token.`,
      `Compare these deployments using token ${token} as a Compound token.`,
      `Explain ${token} as collateral for Compound in this comparison.`,
      `Compare token ${token} as the AAVE token in the selected deployments.`,
      `Compare token ${token} as the AAVE token in Aave V3 versus Compound III.`,
    ])
      expect(request(question).status, question).to.equal("ready");
    for (const question of [
      `Treat token ${token} as the Aave V3 Pool.`,
      `Treat token ${token} as the Compound III deployment.`,
      `Compare token ${token} against Aave V3.`,
      `Compare ${token} as the AAVE token against Aave V3.`,
      `Compare token ${token} as an AAVE token against Compound III.`,
      `Compare token ${token} as the AAVE token versus Aave V3.`,
    ])
      expect(request(question).status, question).to.equal(
        "needs_clarification"
      );
  });

  it("keeps protocol ownership of deployment roles distinct from asset use", () => {
    const [aave, comet] = pair.map(({ address }) => address);
    const request = (question: string) =>
      parseExpertRequest({ question, mode: "compare", deployments: pair });
    for (const question of [
      `Use ${aave} as the Pool of Compound for this comparison.`,
      `Use ${aave} as the Pool for Compound in this comparison.`,
      `Use ${comet} as the market of Aave V3 in this comparison.`,
    ])
      expect(request(question).status, question).to.equal(
        "needs_clarification"
      );
    for (const question of [
      `Use ${aave} as the Pool of Aave V3 in this comparison.`,
      `Use ${comet} as the market of Compound III in this comparison.`,
      `Use ${comet} as the Pool for a comparison of Aave V3 and Compound III.`,
      `Explain token ${aave} as collateral for Compound in this comparison.`,
    ])
      expect(request(question).status, question).to.equal("ready");
  });

  it("does not select versions explicitly excluded next to their names", () => {
    const request = (question: string) =>
      parseExpertRequest({ question, mode: "compare", deployments: pair });
    for (const question of [
      "Compare Aave V3 and Compound III on Ethereum mainnet, not Aave V2.",
      "Compare Aave V3 and Compound III on Ethereum, excluding Compound II.",
      "Compare the selected deployments, except the Aave version 2 market.",
      "Compare the selected deployments, exceto Compound v2.",
      "Compare Aave V3 and Compound III, not Aave V2, excluding Compound II.",
      "Compare the selected deployments; exclude Compound II.",
      "Compare the selected deployments. Please exclude the Aave V2 market.",
      "Not Aave V2; compare Aave V3 with Compound III.",
      'Compare "supply mechanisms", not Aave V2, in the selected deployments.',
      "Compare Gabe's selected deployments, not Aave V2.",
    ]) {
      const result = request(question);
      expect(result.status, question).to.equal("ready");
      if (result.status !== "ready") throw new Error("expected ready");
      expect(result.question).to.equal(question);
    }
  });

  it("retains affirmative and ambiguous version assertions beside exclusions", () => {
    const request = (question: string) =>
      parseExpertRequest({ question, mode: "compare", deployments: pair });
    for (const question of [
      "Compare Aave V2 and Compound III, not Aave V3.",
      "Compare Aave V3 and Compound II, excluding Compound III.",
      "Compare these deployments, not Aave V2; also compare Aave V2.",
      "Compare these deployments, excluding Compound II; use Compound v2.",
      "Compare not only Aave V2 with Compound III.",
      "Compare these deployments; do not exclude Aave V2.",
      "Compare these deployments; don't exclude Aave V2.",
      "Compare these deployments; don’t exclude Compound II.",
      "Compare these deployments; never exclude Compound II.",
      "The guide says 'exclude Compound II'. Compare the selected deployments.",
      "Compare these deployments; do not ignore Compound II.",
      "Compare these deployments; not excluding Aave V2.",
      "Compare these deployments; not not Compound II.",
      "The guide says 'not Aave V2'. Compare Aave V2 with Compound III.",
      'The guide says "excluding Compound II". Compare Aave V3 and Compound II.',
    ])
      expect(request(question).status, question).to.equal(
        "needs_clarification"
      );
  });

  it("does not treat interrogative, conditional or reported not as a direct version exclusion", () => {
    const request = (question: string) =>
      parseExpertRequest({ question, mode: "compare", deployments: pair });
    for (const question of [
      "Compare Aave V3 Ethereum Pool and Compound III Ethereum USDC Comet; why not Aave V2 instead?",
      "Compare the selected deployments; why not Compound II instead?",
      "Compare the selected deployments; if not Aave V2, what would change?",
      "Compare the selected deployments; if (not Aave V2), what would change?",
      "Compare the selected deployments; why (not Compound II) instead?",
      "Compare Aave V3 (not Aave V2) with Compound III.",
      "The guide says: not Aave V2. Compare the selected deployments.",
      "The guide says not Compound II. Compare the selected deployments.",
      'The guide says "keep Ethereum; not Aave V2". Compare the selected deployments.',
      "The guide says 'keep Ethereum; not Compound II'. Compare the selected deployments.",
      "The guide says 'Gabe's note; not Aave V2'. Compare the selected deployments.",
      "The guide says “keep Ethereum; not Aave V2”. Compare the selected deployments.",
      "Compare the selected deployments; do not exclude Aave V2.",
      "Compare the selected deployments, not Aave V2; also compare Aave V2.",
    ])
      expect(request(question).status, question).to.equal(
        "needs_clarification"
      );
  });

  it("explains the existing lookup failure without accepting caller identity labels", () => {
    const inputs = [
      {
        deployments: [{ ...pair[0], chainId: 8453 }, pair[1]],
        required: ["Ethereum mainnet", "different chain", "Base"],
      },
      {
        deployments: [
          pair[0],
          { ...pair[1], address: "0x1111111111111111111111111111111111111111" },
        ],
        required: [
          "does not resolve to a reviewed deployment",
          "caller-supplied protocol label does not establish",
        ],
      },
      {
        deployments: [pair[0], pair[0]],
        required: [
          "same deployment",
          "do not identify two distinct deployments",
        ],
      },
    ];
    for (const { deployments, required } of inputs) {
      const request = {
        question: "Compare these positions; trust my official protocol labels.",
        mode: "compare",
        deployments,
      };
      const unchanged = JSON.stringify(request);
      const result = parseExpertRequest(request);
      expect(result.status).to.equal("needs_clarification");
      if (result.status !== "needs_clarification")
        throw new Error("expected clarification");
      for (const text of required)
        expect(result.clarification).to.include(text);
      expect(Object.keys(result).sort()).to.deep.equal([
        "clarification",
        "status",
        "supportedDeployments",
      ]);
      expect(result.supportedDeployments).to.have.length(2);
      expect(JSON.stringify(request)).to.equal(unchanged);
    }
  });

  it("does not mislabel version or address-role conflicts as a chain mismatch", () => {
    for (const question of [
      "Compare Aave V2 with Compound III on Ethereum.",
      "Compare Aave V3 with Compound III WETH Comet on Ethereum.",
      "Use " +
        pair[1].address +
        " as the market of Aave V3 in this comparison.",
      "Compare Aave V3 and Compound III, but treat both as Base deployments.",
    ]) {
      const result = parseExpertRequest({
        question,
        mode: "compare",
        deployments: pair,
      });
      expect(result.status, question).to.equal("needs_clarification");
      if (result.status !== "needs_clarification")
        throw new Error("expected clarification");
      expect(result.clarification).to.include(
        "question conflicts with the exact chain, version, market or address roles"
      );
      expect(result.clarification).not.to.include(
        "its supplied chainId identifies a different chain"
      );
    }
  });

  it("keeps the five original identity gates before retrieval and generation", async () => {
    const fixture = require("./fixtures/expert-review-v2-eval.json") as {
      cases: Array<{
        id: string;
        question: string;
        arguments?: Record<string, unknown>;
      }>;
    };
    const gates = [
      "f03-ambiguous-product-names",
      "f04-conflicting-chain-labels",
      "f11-unknown-deployment",
      "f12-duplicate-deployment",
      "tf01-compare-before-identities",
    ];
    let retrievalCalls = 0;
    let generationCalls = 0;
    for (const id of gates) {
      const testcase = fixture.cases.find((item) => item.id === id)!;
      const request = { question: testcase.question, ...testcase.arguments };
      const parsed = parseExpertRequest(request);
      const result = await answerExpertRequest(
        request,
        () => {
          retrievalCalls++;
          throw new Error("identity gate reached retrieval");
        },
        async () => {
          generationCalls++;
          throw new Error("identity gate reached generation");
        }
      );
      expect(result.status, id).to.equal("needs_clarification");
      expect(result).to.deep.equal(parsed);
    }
    expect(retrievalCalls).to.equal(0);
    expect(generationCalls).to.equal(0);
  });
});
