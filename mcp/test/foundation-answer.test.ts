import { expect } from "chai";
import { answerFromFoundationSources } from "../src/foundation-answer";
const source = {
  id: "vault-shares",
  title: "Vault shares",
  url: "https://eips.ethereum.org/EIPS/eip-4626",
  sourceFileUrl:
    "https://github.com/ethereum/ERCs/blob/" +
    "a".repeat(40) +
    "/ERCS/erc-4626.md",
  revision: "ethereum/ERCs@" + "a".repeat(40),
  text: "Shares are a fractional claim on underlying holdings.",
};
const good = {
  answer: "Shares represent a fractional claim on underlying holdings.",
  citationIds: [source.id],
  unsupportedParts: [],
};
describe("foundation answer contract (fixture generation)", () => {
  it("validates questions and requires retrieved evidence before generation", async () => {
    let calls = 0;
    const generate = async () => {
      calls++;
      return good;
    };
    expect(
      (await answerFromFoundationSources("", [source], generate)).status
    ).to.equal("invalid_question");
    expect(
      (await answerFromFoundationSources("x".repeat(4001), [source], generate))
        .status
    ).to.equal("invalid_question");
    expect(
      (await answerFromFoundationSources("Explain vault shares", [], generate))
        .status
    ).to.equal("insufficient_evidence");
    expect(calls).to.equal(0);
  });
  it("derives answered from cited content with no unsupported parts", async () => {
    const result = await answerFromFoundationSources(
      "Explain vault shares",
      [source],
      async () => good
    );
    expect(result.status).to.equal("answered");
    expect(result.answer).to.equal(good.answer);
    expect(result.sources).to.deep.equal([
      {
        id: source.id,
        title: source.title,
        url: source.url,
        sourceFileUrl: source.sourceFileUrl,
        revision: source.revision,
      },
    ]);
    expect(result.unsupportedParts).to.deep.equal([]);
  });
  it("derives partial from cited content and explicit unsupported parts", async () => {
    const result = await answerFromFoundationSources(
      "Explain shares and assess this vault today",
      [source],
      async () => ({
        ...good,
        unsupportedParts: [
          "The named vault's current condition is not in these sources.",
        ],
      })
    );
    expect(result.status).to.equal("partial");
    expect(result.answer).to.equal(good.answer);
    expect(result.unsupportedParts).to.have.length(1);
  });
  it("preserves validated gaps on an abstention without answer text or sources", async () => {
    const unsupportedParts = ["Current yields are unavailable."];
    const result = await answerFromFoundationSources(
      "Which vault has the highest APY today?",
      [source],
      async () => ({
        answer: "",
        citationIds: [],
        unsupportedParts,
      })
    );
    expect(result).to.deep.equal({
      status: "insufficient_evidence",
      unsupportedParts: ["Current yields are unavailable."],
    });
    unsupportedParts[0] = "Changed after generation";
    expect(result.unsupportedParts).to.deep.equal([
      "Current yields are unavailable.",
    ]);
  });
  it("does not republish gap text from malformed or uncited generated content", async () => {
    const abstention = {
      answer: "",
      citationIds: [],
      unsupportedParts: ["An observation is unavailable."],
    };
    for (const value of [
      { ...abstention, answer: "An uncited assertion." },
      { ...abstention, citationIds: ["unknown-source"] },
      { ...abstention, citationIds: [source.id] },
      { ...abstention, unsupportedParts: [" "] },
      { ...abstention, unsupportedParts: ["x".repeat(1001)] },
      { ...abstention, unsupportedParts: Array(17).fill("unavailable") },
      { ...abstention, unsupportedParts: Array(1) },
      { ...abstention, status: "insufficient_evidence" },
    ]) {
      expect(
        await answerFromFoundationSources(
          "Explain this observation",
          [source],
          async () => value
        )
      ).to.deep.equal({ status: "insufficient_evidence" });
    }
  });
  it("rejects generated status authority, unsupported citations and invalid content", async () => {
    for (const value of [
      null,
      {
        ...good,
        answer:
          "EOAs authorize transactions [ethereum-transaction-transaction-model].",
      },
      { ...good, citationIds: Array(1) },
      { ...good, unsupportedParts: Array(1) },
      { ...good, status: "answered" },
      { ...good, status: "partial" },
      { ...good, status: "answered", unsupportedParts: ["unanswered part"] },
      { ...good, status: "insufficient_evidence" },
      { ...good, citationIds: ["invented-source"] },
      { ...good, citationIds: [] },
      { ...good, answer: " " },
      { ...good, answer: "x".repeat(16001) },
      { ...good, proceed: true },
      { ...good, unsupportedParts: [""] },
      { ...good, unsupportedParts: [" "] },
      { ...good, unsupportedParts: ["x".repeat(1001)] },
      { ...good, unsupportedParts: Array(17).fill("unsupported") },
      { ...good, answer: "", citationIds: [] },
    ]) {
      const result = await answerFromFoundationSources(
        "Explain shares",
        [source],
        async () => value
      );
      expect(result.status).to.equal("insufficient_evidence");
      expect(result.answer).to.equal(undefined);
    }
  });
  it("does not let the generator rewrite returned source provenance", async () => {
    const mutable = { ...source };
    const result = await answerFromFoundationSources(
      "Explain shares",
      [mutable],
      async ({ sources }) => {
        (sources[0] as any).url = "https://attacker.invalid";
        return good;
      }
    );
    expect(result.status).to.equal("answered");
    expect(result.sources![0].url).to.equal(source.url);
  });
  it("checks every bracketed reference, including punctuation and whitespace", async () => {
    for (const reference of [
      "[unknown/source]",
      "[source with spaces]",
      "[未知]",
      "[]",
      "[[vault-shares]]",
      "[unknown\nsource]",
    ]) {
      const result = await answerFromFoundationSources(
        "Explain shares",
        [source],
        async () => ({ ...good, answer: `See ${reference}.` })
      );
      expect(result.status, reference).to.equal("insufficient_evidence");
    }
    const valid = await answerFromFoundationSources(
      "Explain shares",
      [source],
      async () => ({ ...good, answer: `See [${source.id}].` })
    );
    expect(valid.status).to.equal("answered");
  });
  it("reports provider failure without leaking its error", async () => {
    const result = await answerFromFoundationSources(
      "Explain shares",
      [source],
      async () => {
        throw new Error("PRIVATE_CANARY");
      }
    );
    expect(result).to.deep.equal({ status: "unavailable" });
  });
});
