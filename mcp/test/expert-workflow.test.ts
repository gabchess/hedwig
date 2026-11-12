import { expect } from "chai";
import type { FoundationSource, FoundationRetriever } from "../src/knowledge";
import { SUPPORTED_DEPLOYMENTS } from "../src/expert-request";

import {
  answerExpertRequest,
  prepareExpertRequest,
} from "../src/expert-workflow";
import type { GenerateFoundationAnswer } from "../src/foundation-answer";

const pair = SUPPORTED_DEPLOYMENTS.map(({ chainId, address }) => ({
  chainId,
  address,
}));
const identityIds = [
  "aave-v3-ethereum-identity",
  "compound-iii-ethereum-usdc-identity",
];
function evidence(id: string): FoundationSource {
  return {
    id,
    title: id,
    text: "Documented mechanism snapshot.",
    url: "https://example.com/reference",
    sourceFileUrl:
      SUPPORTED_DEPLOYMENTS[identityIds.indexOf(id)]?.sourceFileUrl ??
      "https://example.com/revision/reference",
    revision: "example@" + "a".repeat(40),
  };
}

function comparisonContent() {
  return {
    sections: Object.fromEntries(
      SUPPORTED_DEPLOYMENTS.map((deployment, index) => [
        deployment.id,
        {
          requested: true,
          answer: `Documented mechanism ${index + 1}.`,
          citationIds: [identityIds[index]],
          unsupportedParts: [],
        },
      ])
    ),
  };
}

const partitionedRetriever: FoundationRetriever = (question, options) => {
  if (pair.some((deployment) => deployment.address === question))
    return identityIds.map(evidence);
  if (options?.excludeTopics) return [evidence("common-context")];
  return [
    evidence(options?.topics?.[0] === "Aave V3" ? "opaque-z" : "opaque-a"),
  ];
};

describe("expert comparison workflow", () => {
  it("preserves both trusted identities when only one deployment is requested", async () => {
    const [left, right] = SUPPORTED_DEPLOYMENTS.map(
      (deployment) => deployment.id
    );
    const raw = comparisonContent();
    raw.sections[left] = {
      requested: false,
      answer: "",
      citationIds: [],
      unsupportedParts: [],
    };
    raw.sections[right].citationIds = ["opaque-a"];
    const result = await answerExpertRequest(
      {
        question: "Explain only Compound III.",
        mode: "compare",
        deployments: pair,
      },
      partitionedRetriever,
      async () => raw
    );
    expect(result.status).to.equal("answered");
    if (result.status !== "answered" || !("comparison" in result))
      throw new Error("expected comparison answer");
    expect(result.answer).to.equal(
      `${SUPPORTED_DEPLOYMENTS[1].name}:\nDocumented mechanism 2.`
    );
    expect(result.unsupportedParts).to.deep.equal([]);
    expect(result.sources.map((source) => source.id)).to.deep.equal([
      ...identityIds,
      "opaque-a",
    ]);
    expect(result.comparison.deployments).to.deep.equal(SUPPORTED_DEPLOYMENTS);
    expect(result.comparison.liveStateVerified).to.equal(false);
    expect(result).not.to.have.property("requested");
  });

  it("returns trusted identity provenance even when prose cites only mechanisms", async () => {
    const raw = comparisonContent();
    const mechanisms = ["opaque-z", "opaque-a"];
    SUPPORTED_DEPLOYMENTS.forEach((deployment, index) => {
      raw.sections[deployment.id].citationIds = [mechanisms[index]];
    });
    const result = await answerExpertRequest(
      { question: "Compare mechanisms", mode: "compare", deployments: pair },
      partitionedRetriever,
      async () => raw
    );
    expect(result.status).to.equal("answered");
    if (result.status !== "answered") throw new Error("expected answer");
    expect(result.sources.map((source) => source.id)).to.deep.equal([
      ...identityIds,
      ...mechanisms,
    ]);
    for (const [index, id] of identityIds.entries()) {
      const source = result.sources.find((item) => item.id === id);
      expect(source?.sourceFileUrl).to.equal(
        SUPPORTED_DEPLOYMENTS[index].sourceFileUrl
      );
      expect(source).not.to.have.property("text");
    }
  });

  it("requires one scoped section per deployment and formats the existing public answer", async () => {
    let calls = 0;
    const result = await answerExpertRequest(
      { question: "Compare mechanisms", mode: "compare", deployments: pair },
      partitionedRetriever,
      async (input) => {
        calls++;
        const comparison = input.comparison;
        if (!comparison) throw new Error("expected comparison context");
        expect(comparison.evidence).to.deep.equal({
          byDeployment: {
            [SUPPORTED_DEPLOYMENTS[0].id]: [identityIds[0], "opaque-z"],
            [SUPPORTED_DEPLOYMENTS[1].id]: [identityIds[1], "opaque-a"],
          },
          sharedSourceIds: ["common-context"],
        });
        return comparisonContent();
      }
    );
    expect(calls).to.equal(1);
    expect(result.status).to.equal("answered");
    if (result.status !== "answered") throw new Error("expected answer");
    expect(result.answer).to.equal(
      `${SUPPORTED_DEPLOYMENTS[0].name}:\nDocumented mechanism 1.\n\n${SUPPORTED_DEPLOYMENTS[1].name}:\nDocumented mechanism 2.`
    );
    expect(result.sources.map((source) => source.id)).to.deep.equal(
      identityIds
    );
    expect(result).not.to.have.property("sections");
    expect(result).to.have.property("comparison");
    if (!("comparison" in result))
      throw new Error("expected comparison metadata");
    expect(result.comparison).not.to.have.property("evidence");
  });

  it("rejects omitted, extra, duplicate or unrecognized sections and cross-protocol citations", async () => {
    const [left, right] = SUPPORTED_DEPLOYMENTS.map(
      (deployment) => deployment.id
    );
    const valid = comparisonContent();
    for (const raw of [
      { sections: { [left]: valid.sections[left] } },
      { sections: { ...valid.sections, other: valid.sections[left] } },
      {
        sections: [
          { deploymentId: left, ...valid.sections[left] },
          { deploymentId: left, ...valid.sections[left] },
        ],
      },
      {
        sections: {
          ...valid.sections,
          [right]: { ...valid.sections[right], citationIds: ["opaque-z"] },
        },
      },
      {
        sections: {
          ...valid.sections,
          [right]: {
            requested: true,
            answer: "",
            citationIds: [],
            unsupportedParts: [],
          },
        },
      },
      { ...valid, summary: "Unsupported generated summary." },
    ]) {
      expect(
        await answerExpertRequest(
          {
            question: "Compare mechanisms",
            mode: "compare",
            deployments: pair,
          },
          partitionedRetriever,
          async () => raw
        )
      ).to.deep.equal({ status: "insufficient_evidence" });
    }
  });

  it("accepts shared evidence in either section and preserves scoped abstentions", async () => {
    const [left, right] = SUPPORTED_DEPLOYMENTS.map(
      (deployment) => deployment.id
    );
    const valid = comparisonContent();
    const raw = {
      sections: {
        [left]: { ...valid.sections[left], citationIds: ["common-context"] },
        [right]: {
          requested: true,
          answer: "",
          citationIds: [],
          unsupportedParts: ["Current observation unavailable."],
        },
      },
    };
    const partial = await answerExpertRequest(
      { question: "Compare mechanisms", mode: "compare", deployments: pair },
      partitionedRetriever,
      async () => raw
    );
    expect(partial.status).to.equal("partial");
    if (partial.status !== "partial") throw new Error("expected partial");
    expect(partial.answer).to.equal(
      `${SUPPORTED_DEPLOYMENTS[0].name}:\nDocumented mechanism 1.`
    );
    expect(partial.sources.map((source) => source.id)).to.deep.equal([
      ...identityIds,
      "common-context",
    ]);
    expect(partial.unsupportedParts).to.deep.equal([
      `${SUPPORTED_DEPLOYMENTS[1].name}: Current observation unavailable.`,
    ]);
    raw.sections[left] = raw.sections[right];
    expect(
      await answerExpertRequest(
        { question: "Compare mechanisms", mode: "compare", deployments: pair },
        partitionedRetriever,
        async () => raw
      )
    ).to.deep.equal({
      status: "insufficient_evidence",
      unsupportedParts: SUPPORTED_DEPLOYMENTS.map(
        (deployment) => `${deployment.name}: Current observation unavailable.`
      ),
    });
  });

  it("does not allow generator mutation to widen the citation groups", async () => {
    const raw = comparisonContent();
    const right = SUPPORTED_DEPLOYMENTS[1].id;
    raw.sections[right].citationIds = ["opaque-z"];
    for (const mutateShared of [false, true]) {
      const result = await answerExpertRequest(
        { question: "Compare mechanisms", mode: "compare", deployments: pair },
        partitionedRetriever,
        async (input) => {
          if (!input.comparison) throw new Error("expected comparison context");
          const ids = mutateShared
            ? input.comparison.evidence.sharedSourceIds
            : input.comparison.evidence.byDeployment[right];
          (ids as string[]).push("opaque-z");
          return raw;
        }
      );
      expect(result).to.deep.equal({ status: "insufficient_evidence" });
    }
  });

  it("propagates cancellation and discards a comparison completed after cancellation", async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = await answerExpertRequest(
      { question: "Compare mechanisms", mode: "compare", deployments: pair },
      partitionedRetriever,
      async (input) => {
        calls++;
        expect(input.signal).to.equal(controller.signal);
        controller.abort();
        return comparisonContent();
      },
      controller.signal
    );
    expect(calls).to.equal(1);
    expect(result.status).to.equal("unavailable");
    expect(result).not.to.have.property("answer");
  });
  it("preserves inspectable reference metadata when the provider is unavailable", async () => {
    const result = await answerExpertRequest(
      { question: "Compare", mode: "compare", deployments: pair },
      () => identityIds.map(evidence),
      async () => {
        throw new Error("provider unavailable");
      }
    );
    expect(result.status).to.equal("unavailable");
    if (result.status !== "unavailable" || !("availableSources" in result))
      throw new Error("expected reference metadata");
    expect(result.availableSources.map((s) => s.id)).to.deep.equal(identityIds);
    expect(result.availableSources.every((s) => !("text" in s))).to.equal(true);
    expect(result).not.to.have.property("answer");
  });
  it("keeps returned deployment identity independent of generator mutation", async () => {
    const result = await answerExpertRequest(
      { question: "Compare", mode: "compare", deployments: pair },
      () => identityIds.map(evidence),
      async (input) => {
        if (input.comparison) {
          Object.assign(input.comparison, { liveStateVerified: true });
          Object.assign(input.comparison.deployments[0], {
            address: "0x" + "1".repeat(40),
            name: "Untrusted replacement label",
          });
        }
        Object.assign(input.sources[0], { url: "https://untrusted.invalid" });
        return comparisonContent();
      }
    );
    if (result.status !== "answered" || !("comparison" in result))
      throw new Error("expected comparison answer");
    expect(result.comparison.liveStateVerified).to.equal(false);
    expect(result.comparison.deployments).to.deep.equal(SUPPORTED_DEPLOYMENTS);
    expect(result.answer).to.contain(SUPPORTED_DEPLOYMENTS[0].name);
    expect(result.answer).not.to.contain("Untrusted replacement label");
    expect(result.sources[0].url).to.equal(evidence(identityIds[0]).url);
  });
  it("allocates separate bounded mechanism slots to each selected protocol", () => {
    const retrieve: FoundationRetriever = (question, options) => {
      if (pair.some((p) => p.address === question))
        return identityIds.map(evidence);
      if (options?.excludeTopics) {
        expect(options.excludeTopics).to.deep.equal([
          "Aave V3",
          "Compound III",
        ]);
        expect(options.excludeIds).to.include.members(identityIds);
        expect(options.limit).to.equal(2);
        return [evidence("shared-issuer"), evidence("shared-bridge")];
      }
      const topic = options?.topics?.[0];
      expect(options?.excludeIds).to.deep.equal(identityIds);
      expect(options?.limit).to.equal(6);
      return Array.from({ length: 6 }, (_, i) => evidence(`${topic}-${i}`));
    };
    const prepared = prepareExpertRequest(
      { question: "Compare lending.", mode: "compare", deployments: pair },
      retrieve
    );
    if (prepared.status !== "ready")
      throw new Error("expected prepared comparison");
    expect(prepared.sources).to.have.length(16);
    expect(prepared.sources.map((s) => s.id)).to.include.members([
      "shared-issuer",
      "shared-bridge",
    ]);
    expect(
      prepared.sources.filter((s) => s.id.startsWith("Aave V3-"))
    ).to.have.length(6);
    expect(
      prepared.sources.filter((s) => s.id.startsWith("Compound III-"))
    ).to.have.length(6);
  });
  it("clarifies identity before any retrieval or generation", async () => {
    let operations = 0;
    const result = await answerExpertRequest(
      { question: "Compare", mode: "compare" },
      () => {
        operations++;
        return [];
      },
      async () => {
        operations++;
      }
    );
    expect(result?.status).to.equal("needs_clarification");
    expect(operations).to.equal(0);
  });

  it("requires both identity evidence units before generation", async () => {
    let generated = false;
    const result = await answerExpertRequest(
      { question: "Compare", mode: "compare", deployments: pair },
      () => [evidence(identityIds[0])],
      async () => {
        generated = true;
      }
    );
    expect(result?.status).to.equal("insufficient_evidence");
    expect(generated).to.equal(false);
  });

  it("pins both deployments and bounds evidence while preserving cited output", async () => {
    const calls: Parameters<GenerateFoundationAnswer>[0][] = [];
    const retrieved = [
      ...identityIds,
      ...Array.from({ length: 20 }, (_, i) => "mechanism-" + i),
    ].map(evidence);
    const result = await answerExpertRequest(
      {
        question: "Compare lending mechanisms.",
        mode: "compare",
        deployments: pair,
      },
      () => retrieved,
      async (input) => {
        calls.push(input);
        return comparisonContent();
      }
    );
    expect(result?.status).to.equal("answered");
    if (result.status !== "answered" || !("comparison" in result))
      throw new Error("expected comparison answer");
    const seen = calls[0];
    expect(seen.sources.length).to.be.at.most(16);
    expect(seen.comparison?.deployments).to.have.length(2);
    expect(seen.comparison?.liveStateVerified).to.equal(false);
    expect(result.comparison.deployments).to.deep.equal(SUPPORTED_DEPLOYMENTS);
    expect(result.comparison.liveStateVerified).to.equal(false);
    expect(result.sources.map((s) => s.id)).to.deep.equal(identityIds);
  });

  it("refuses identity evidence whose pin differs from the resolved registry", async () => {
    let calls = 0;
    const result = await answerExpertRequest(
      { question: "Compare", mode: "compare", deployments: pair },
      () =>
        identityIds.map((id) => ({
          ...evidence(id),
          sourceFileUrl: "https://example.com/other-revision",
        })),
      async () => {
        calls++;
        return {};
      }
    );
    expect(result.status).to.equal("insufficient_evidence");
    expect(calls).to.equal(0);
  });
});
