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
  status: "answered",
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
  it("returns generated answers with only retrieved provenance", async () => {
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
  it("keeps the unsupported part of a mixed question explicit", async () => {
    const result = await answerFromFoundationSources(
      "Explain shares and assess this vault today",
      [source],
      async () => ({
        ...good,
        status: "partial",
        unsupportedParts: [
          "The named vault's current condition is not in these sources.",
        ],
      })
    );
    expect(result.status).to.equal("partial");
    expect(result.answer).to.equal(good.answer);
    expect(result.unsupportedParts).to.have.length(1);
  });
  it("preserves a model abstention without inventing answer text", async () => {
    const result = await answerFromFoundationSources(
      "Which vault has the highest APY today?",
      [source],
      async () => ({
        status: "insufficient_evidence",
        answer: "",
        citationIds: [],
        unsupportedParts: ["Current yields are unavailable."],
      })
    );
    expect(result.status).to.equal("insufficient_evidence");
    expect(result.answer).to.equal(undefined);
  });
  it("rejects inconsistent statuses, unsupported citations and extra output fields", async () => {
    for (const value of [
      null,
      {
        ...good,
        answer:
          "EOAs authorize transactions [ethereum-transaction-transaction-model].",
      },
      { ...good, citationIds: Array(1) },
      { ...good, status: "partial", unsupportedParts: Array(1) },
      { ...good, status: "partial" },
      { ...good, unsupportedParts: ["unanswered part"] },
      { ...good, status: "insufficient_evidence" },
      { ...good, citationIds: ["invented-source"] },
      { ...good, citationIds: [] },
      { ...good, answer: " " },
      { ...good, answer: "x".repeat(16001) },
      { ...good, proceed: true },
      { ...good, status: "partial", unsupportedParts: [""] },
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
