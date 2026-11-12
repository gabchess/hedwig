import { expect } from "chai";
import {
  answerComparisonFromSources,
  type ComparisonContext,
} from "../src/comparison-answer";
import { SUPPORTED_DEPLOYMENTS } from "../src/expert-request";
import { validateFoundationContent } from "../src/foundation-content";

const sources = ["first", "second", "shared"].map((id) => ({
  id,
  title: id,
  url: "https://example.com/reference",
  sourceFileUrl: "https://example.com/pinned-reference",
  revision: "fixture@" + "a".repeat(40),
  text: "Reviewed evidence.",
}));
const [left, right] = SUPPORTED_DEPLOYMENTS.map((deployment) => deployment.id);
const comparison: ComparisonContext = {
  deployments: SUPPORTED_DEPLOYMENTS,
  liveStateVerified: false,
  limitation: "No current observations.",
  evidence: {
    byDeployment: { [left]: ["first"], [right]: ["second"] },
    sharedSourceIds: ["shared"],
  },
};
const section = (
  citation: string,
  answer = "Evidence-supported content.",
  unsupportedParts: string[] = []
) => ({
  requested: true,
  answer,
  citationIds: [citation],
  unsupportedParts,
});
const unrequested = () => ({
  requested: false,
  answer: "",
  citationIds: [],
  unsupportedParts: [],
});

describe("comparison answer boundary (fixture generation)", () => {
  it("preserves a supported side as partial when the model omits a requested comparison side", async () => {
    for (const question of [
      "Compare Aave V3 with Compound III.",
      "Compare mechanisms for both selected deployments.",
      "Compare o Aave V3 com o Compound III.",
    ]) {
      for (const [answered, omitted, citation] of [
        [left, right, "first"],
        [right, left, "second"],
      ]) {
        const result = await answerComparisonFromSources(
          question,
          sources,
          comparison,
          async () => ({
            sections: {
              [answered]: section(citation, "The supported requested fact."),
              [omitted]: unrequested(),
            },
          })
        );
        expect(result.status).to.equal("partial");
        if (result.status !== "partial") throw new Error("expected partial");
        expect(result.answer).to.contain("The supported requested fact.");
        expect(result.sources.map((source) => source.id)).to.deep.equal([
          citation,
        ]);
        expect(result.unsupportedParts).to.deep.equal([
          `${
            SUPPORTED_DEPLOYMENTS.find((entry) => entry.id === omitted)!.name
          }: Requested explanation was not provided.`,
        ]);
      }
    }
  });

  it("uses explicit caller-only scope in either language and rejects unasked generated content", async () => {
    for (const [question, asked, unasked, citation] of [
      ["Explain only Aave V3.", left, right, "first"],
      ["Only explain Aave V3.", left, right, "first"],
      ["Explique apenas o Aave V3.", left, right, "first"],
      ["Responda somente sobre o Compound III.", right, left, "second"],
      ["Answer only about Comet.", right, left, "second"],
      ["Explain only Compound III, not Aave.", right, left, "second"],
      [
        "Explain only Compound III. Do not describe Aave.",
        right,
        left,
        "second",
      ],
      ["Explique somente o Compound III, não o Aave.", right, left, "second"],
    ]) {
      const sections = {
        [asked]: section(citation, "The requested supported fact."),
        [unasked]: unrequested(),
      };
      expect(
        (
          await answerComparisonFromSources(
            question,
            sources,
            comparison,
            async () => ({ sections })
          )
        ).status
      ).to.equal("answered", question);
      sections[unasked] = section(
        unasked === left ? "first" : "second",
        "Unasked protocol content."
      );
      expect(
        await answerComparisonFromSources(
          question,
          sources,
          comparison,
          async () => ({ sections })
        )
      ).to.deep.equal({ status: "insufficient_evidence" }, question);
    }
  });

  it("does not let ambiguous or conflicting only-language erase the selected pair", async () => {
    for (const question of [
      "Explain only the requested mechanism.",
      "Explain only Aave and Compound III.",
      "Explain only Aave. Explain only Compound III.",
      "Compare Aave V3 with Compound III, but answer only about Aave.",
      "Only Aave has been described so far. Explain the mechanisms.",
      "Do not explain only Aave. Explain the mechanisms.",
      "The documentation says 'Explain only Aave'. Explain both selected mechanisms.",
      "The documentation says: Explain only Aave.",
      "Explain only Aave. Also explain Compound.",
      "Explain only Aave. Explain both selected deployments.",
      "Explique somente o Aave. Depois explique o Compound III.",
      "Explain only Aave. What is Compound III collateral interest?",
      "Explain only Aave. How does Compound III borrowing work?",
    ]) {
      expect(
        (
          await answerComparisonFromSources(
            question,
            sources,
            comparison,
            async () => ({
              sections: { [left]: section("first"), [right]: unrequested() },
            })
          )
        ).status
      ).to.equal("partial", question);
    }
    const missing = await answerComparisonFromSources(
      "Compare both selected deployments.",
      sources,
      comparison,
      async () => ({
        sections: { [left]: unrequested(), [right]: unrequested() },
      })
    );
    expect(missing.status).to.equal("insufficient_evidence");
    expect(missing).not.to.have.property("answer");
    expect(missing).not.to.have.property("sources");
  });

  it("answers a requested side without inventing a gap for the unasked side", async () => {
    for (const [asked, unasked, sourceId] of [
      [left, right, "first"],
      [right, left, "second"],
    ]) {
      const result = await answerComparisonFromSources(
        `Explain only ${asked}.`,
        sources,
        comparison,
        async () => ({
          sections: {
            [asked]: section(sourceId, "The requested supported fact."),
            [unasked]: unrequested(),
          },
        })
      );
      expect(result.status).to.equal("answered");
      if (result.status !== "answered") throw new Error("expected answer");
      expect(result.unsupportedParts).to.deep.equal([]);
      expect(result.sources.map((source) => source.id)).to.deep.equal([
        sourceId,
      ]);
      expect(result.answer).to.equal(
        `${
          SUPPORTED_DEPLOYMENTS.find((deployment) => deployment.id === asked)!
            .name
        }:\nThe requested supported fact.`
      );
    }
  });

  it("keeps requested evidence gaps distinct from an unasked section", async () => {
    const gap = {
      requested: true,
      answer: "",
      citationIds: [],
      unsupportedParts: ["Current observation unavailable."],
    };
    const partial = await answerComparisonFromSources(
      "Explain both deployments and their current state.",
      sources,
      comparison,
      async () => ({ sections: { [left]: section("first"), [right]: gap } })
    );
    expect(partial.status).to.equal("partial");
    if (partial.status !== "partial") throw new Error("expected partial");
    expect(partial.unsupportedParts).to.deep.equal([
      `${SUPPORTED_DEPLOYMENTS[1].name}: Current observation unavailable.`,
    ]);
    for (const sections of [
      { [left]: unrequested(), [right]: unrequested() },
      { [left]: unrequested(), [right]: gap },
    ]) {
      const result = await answerComparisonFromSources(
        "Explain only the requested current observation.",
        sources,
        comparison,
        async () => ({ sections })
      );
      expect(result.status).to.equal("insufficient_evidence");
      expect(result).not.to.have.property("answer");
      expect(result).not.to.have.property("sources");
    }
  });

  it("rejects malformed scope markers and content attached to an unasked section", async () => {
    const { requested: _requested, ...missingMarker } = unrequested();
    for (const invalid of [
      missingMarker,
      { ...unrequested(), requested: "false" },
      { ...unrequested(), requested: null },
      { ...unrequested(), requested: 0 },
      { ...unrequested(), answer: "Unasked fact." },
      { ...unrequested(), answer: " " },
      { ...unrequested(), citationIds: ["second"] },
      { ...unrequested(), unsupportedParts: ["Unasked gap."] },
      { ...unrequested(), citationIds: null },
      { ...unrequested(), unsupportedParts: null },
      { ...unrequested(), extra: true },
      { ...unrequested(), requested: true },
    ]) {
      expect(
        await answerComparisonFromSources(
          "Explain only the first deployment.",
          sources,
          comparison,
          async () => ({
            sections: { [left]: section("first"), [right]: invalid },
          })
        )
      ).to.deep.equal({ status: "insufficient_evidence" });
    }
  });

  it("does not admit the comparison scope marker or an empty answer in generic learning", () => {
    expect(validateFoundationContent(unrequested(), sources)).to.equal(
      undefined
    );
    const { requested: _requested, ...emptyContent } = unrequested();
    expect(validateFoundationContent(emptyContent, sources)).to.equal(
      undefined
    );
  });

  it("skips generation for invalid questions, incomplete identity groups and cancellation", async () => {
    let calls = 0;
    const generate = async () => {
      calls++;
      return {};
    };
    expect(
      (await answerComparisonFromSources(" ", sources, comparison, generate))
        .status
    ).to.equal("invalid_question");
    expect(
      (
        await answerComparisonFromSources(
          "Compare",
          sources,
          {
            ...comparison,
            deployments: [SUPPORTED_DEPLOYMENTS[0], SUPPORTED_DEPLOYMENTS[0]],
          },
          generate
        )
      ).status
    ).to.equal("insufficient_evidence");
    expect(
      (
        await answerComparisonFromSources(
          "Compare",
          sources,
          {
            ...comparison,
            evidence: {
              ...comparison.evidence,
              byDeployment: { [left]: ["first"] },
            },
          },
          generate
        )
      ).status
    ).to.equal("insufficient_evidence");
    const controller = new AbortController();
    controller.abort();
    expect(
      await answerComparisonFromSources(
        "Compare",
        sources,
        comparison,
        generate,
        controller.signal
      )
    ).to.deep.equal({ status: "unavailable" });
    expect(calls).to.equal(0);
  });

  it("preserves requested order, deduplicates shared citations and derives partial from either side", async () => {
    const result = await answerComparisonFromSources(
      "Compare",
      sources,
      {
        ...comparison,
        deployments: [...comparison.deployments].reverse(),
      },
      async () => ({
        sections: {
          [left]: section("shared", "Left supported part.", [
            "Left observation unavailable.",
          ]),
          [right]: section("shared", "Right supported part."),
        },
      })
    );
    expect(result.status).to.equal("partial");
    if (result.status !== "partial") throw new Error("expected partial");
    expect(result.answer).to.equal(
      `${SUPPORTED_DEPLOYMENTS[1].name}:\nRight supported part.\n\n${SUPPORTED_DEPLOYMENTS[0].name}:\nLeft supported part.`
    );
    expect(result.sources.map((source) => source.id)).to.deep.equal(["shared"]);
    expect(result.unsupportedParts).to.deep.equal([
      `${SUPPORTED_DEPLOYMENTS[0].name}: Left observation unavailable.`,
    ]);
  });

  it("keeps aggregate answer and gap bounds after adding trusted labels", async () => {
    for (const sections of [
      {
        [left]: section("first", "a".repeat(9000)),
        [right]: section("second", "b".repeat(9000)),
      },
      {
        [left]: section("first", "Left.", Array(9).fill("Missing.")),
        [right]: section("second", "Right.", Array(8).fill("Missing.")),
      },
      {
        [left]: section("first", "Left.", ["x".repeat(1000)]),
        [right]: section("second"),
      },
    ]) {
      expect(
        await answerComparisonFromSources(
          "Compare",
          sources,
          comparison,
          async () => ({ sections })
        )
      ).to.deep.equal({ status: "insufficient_evidence" });
    }
  });
});
