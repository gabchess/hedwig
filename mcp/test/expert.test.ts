import { expect } from "chai";

import { answerLearningQuestion, type ExpertSource } from "../src/expert";

describe("answerLearningQuestion", () => {
  const answer = "supported seed answer";

  function generator(
    calls: Array<{ question: string; sources: readonly ExpertSource[] }>
  ) {
    return async (input: {
      question: string;
      sources: readonly ExpertSource[];
    }) => {
      calls.push(input);
      return {
        answer,
        citationIds: input.sources.map(({ id }) => id),
      };
    };
  }

  it("answers only the four reviewed seed questions", async () => {
    const cases = [
      ["What are ERC-4626 vault shares?", "erc4626-shares"],
      ["What do ERC-4626 vault shares represent?", "erc4626-shares"],
      ["What is the facilitator role in x402?", "x402-roles"],
      ["What can an x402 V2 facilitator do?", "x402-roles"],
    ] as const;

    for (const [question, expectedSourceId] of cases) {
      const calls: Array<{
        question: string;
        sources: readonly ExpertSource[];
      }> = [];
      const result = await answerLearningQuestion(question, generator(calls));

      expect(result.status, question).to.equal("answered");
      expect(calls, question).to.have.length(1);
      expect(
        calls[0].sources.map(({ id }) => id),
        question
      ).to.deep.equal([expectedSourceId]);
      if (result.status === "answered") {
        expect(result.answer).to.equal(answer);
        expect(result.sources.map(({ id }) => id)).to.deep.equal([
          expectedSourceId,
        ]);
      }
    }
  });

  it("allows case, whitespace, and final question-mark differences", async () => {
    const variants = [
      "  wHAt   aRE ERC-4626   vault shares  ",
      "WHAT DO ERC-4626 VAULT SHARES REPRESENT???",
      "  what IS the facilitator role in X402?  ",
      "WHAT CAN AN X402 V2 FACILITATOR DO",
    ];

    for (const question of variants) {
      const calls: Array<{
        question: string;
        sources: readonly ExpertSource[];
      }> = [];
      const result = await answerLearningQuestion(question, generator(calls));
      expect(result.status, question).to.equal("answered");
      expect(calls, question).to.have.length(1);
    }
  });

  it("rejects unsupported, mixed, stuffed, and irrelevant questions before generation", async () => {
    const questions = [
      "What is the current live yield of ERC-4626 vault shares?",
      "Are ERC-4626 vault shares safe to deposit into?",
      "What is the address for this ERC-4626 vault?",
      "What is the precise ERC-4626 share rounding formula?",
      "What headers does x402 V1 use?",
      "How does x402 work with Solana rent?",
      "What are ERC-4626 vault shares and what can an x402 V2 facilitator do?",
      "What are ERC-4626 vault shares? What is the capital of France?",
      "What are ERC-4626 vault shares? Also explain yield, deposit safety, and the precise rounding formula.",
      "What is the capital of France?",
      "__proto__",
      "constructor",
    ];

    for (const question of questions) {
      const calls: Array<{
        question: string;
        sources: readonly ExpertSource[];
      }> = [];
      const result = await answerLearningQuestion(question, generator(calls));
      expect(result.status, question).to.equal("insufficient_evidence");
      expect(calls, question).to.have.length(0);
    }
  });

  it("preserves input validation before generation", async () => {
    const calls: Array<{ question: string; sources: readonly ExpertSource[] }> =
      [];
    for (const question of ["", "   ", "x".repeat(4001), null, 42] as const) {
      const result = await answerLearningQuestion(
        question as never,
        generator(calls)
      );
      expect(result.status).to.equal("invalid_question");
    }
    expect(calls).to.have.length(0);
  });

  it("still rejects citations outside the eligible source set", async () => {
    const result = await answerLearningQuestion(
      "What are ERC-4626 vault shares?",
      async () => ({
        answer,
        citationIds: ["x402-roles"],
      })
    );

    expect(result.status).to.equal("insufficient_evidence");
  });
});
