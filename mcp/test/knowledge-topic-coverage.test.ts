import { expect } from "chai";

import {
  buildFoundationRetriever,
  retrieveFoundationSources,
  type FoundationSelection,
} from "../src/knowledge";
import { prepareExpertRequest } from "../src/expert-workflow";
import expertReview from "./fixtures/expert-review-v2-eval.json";

function fixtureRetriever() {
  const commit = "a".repeat(40);
  return buildFoundationRetriever({
    schemaVersion: 1,
    sources: [
      {
        sourceId: "fixture",
        title: "Reference notes",
        url: "https://example.test/notes",
        sourceFileUrl: `https://github.com/example/notes/blob/${commit}/notes.md`,
        revision: `example/notes@${commit}`,
        blobSha: "b".repeat(40),
        license: "MIT",
        licenseUrl: `https://github.com/example/notes/blob/${commit}/LICENSE`,
        licenseBlobSha: "c".repeat(40),
        chunks: [
          ...["settings-a", "settings-b", "settings-c"].map((id) => ({
            id,
            topics: ["Orion"],
            keywords: [],
            text: "Orion release settings status settings status release.",
          })),
          {
            id: "settlement",
            topics: ["Orion", "settlement finality"],
            keywords: [],
            text:
              "Settlement finality requires confirmation. " +
              "Background reference material. ".repeat(100),
          },
          {
            id: "other-settlement",
            topics: ["Other", "settlement finality"],
            keywords: [],
            text: "Settlement finality reference.",
          },
        ],
      },
    ],
  });
}

describe("scoped evidence topic coverage", () => {
  const question = "Orion release settings status and settlement finality";

  it("reserves a named mechanism instead of filling the budget with redundant scope matches", () => {
    const retrieve = fixtureRetriever();
    const selected = retrieve(question, { topics: ["Orion"], limit: 2 });
    expect(selected.map(({ id }) => id)).to.deep.equal([
      "settings-a",
      "settlement",
    ]);
    expect(selected[1].text).to.equal(
      "Settlement finality requires confirmation. " +
        "Background reference material. ".repeat(100)
    );
  });

  it("keeps existing order when named topics already fit and does not enlarge a small budget", () => {
    const retrieve = fixtureRetriever();
    const selected = retrieve(question, { topics: ["Orion"], limit: 4 });
    expect(selected.map(({ id }) => id)).to.deep.equal([
      "settings-a",
      "settings-b",
      "settings-c",
      "settlement",
    ]);
    expect(
      retrieve(question, { topics: ["Orion"], limit: 1 }).map(({ id }) => id)
    ).to.deep.equal(["settlement"]);
  });

  it("requires the complete topic phrase and leaves unscoped ranking alone", () => {
    const retrieve = fixtureRetriever();
    for (const text of [
      "Orion release settings status and settlement",
      "Orion release settings status and presettlement finality",
      "Orion release settings status and finality settlement",
    ]) {
      expect(
        retrieve(text, { topics: ["Orion"], limit: 2 }).map(({ id }) => id),
        text
      ).to.deep.equal(["settings-a", "settings-b"]);
    }
    expect(
      retrieve(question, { excludeTopics: ["Other"], limit: 2 }).map(
        ({ id }) => id
      )
    ).to.deep.equal(["settings-a", "settings-b"]);
  });

  it("honors scope and reserved/excluded evidence before coverage selection", () => {
    const retrieve = fixtureRetriever();
    expect(
      retrieve(question, {
        topics: ["Orion"],
        excludeIds: ["settlement"],
        limit: 2,
      }).map(({ id }) => id)
    ).to.deep.equal(["settings-a", "settings-b"]);
    expect(
      retrieve(question, {
        topics: ["Orion"],
        excludeTopics: ["settlement finality"],
        limit: 2,
      }).map(({ id }) => id)
    ).to.deep.equal(["settings-a", "settings-b"]);
  });

  it("accounts for actual selected and omitted positive candidates after coverage selection", () => {
    let selection: FoundationSelection | undefined;
    const sources = fixtureRetriever()(question, {
      topics: ["Orion"],
      limit: 2,
      onSelection: (value) => {
        selection = value;
      },
    });
    expect(selection).to.deep.equal({
      limit: 2,
      eligibleCandidateIds: [
        "settings-a",
        "settlement",
        "settings-b",
        "settings-c",
      ],
      selectedIds: sources.map(({ id }) => id),
      omittedIds: ["settings-b", "settings-c"],
      omissionReason: "source_limit",
    });
  });

  it("includes both liquidation mechanisms with rates and configuration evidence inside the existing comparison limits", () => {
    const example = expertReview.cases.find(
      ({ id }) => id === "c11-snapshot-versus-configuration"
    );
    if (!example) throw new Error("archived mechanism regression is missing");
    const prepared = prepareExpertRequest(
      { question: example.question, ...example.arguments },
      retrieveFoundationSources
    );
    if (prepared.status !== "ready" || prepared.mode !== "compare")
      throw new Error("comparison did not prepare");
    expect(prepared.sources).to.have.length.at.most(16);
    expect(prepared.sources.map(({ id }) => id)).to.include.members([
      "aave-v3-health-liquidation",
      "aave-v3-risk-parameters",
      "aave-v3-freeze-pause",
      "aave-v3-reserve-accrual",
      "compound-iii-liquidation",
      "compound-iii-oracle-caps",
      "compound-iii-upgrades-pauses",
      "compound-iii-interest-utilization",
      ...example.requiredSourceIds,
    ]);
    for (const stage of prepared.evidenceSelection.stages) {
      if (stage.stage === "mechanisms" && stage.diagnostics === "reported")
        expect(stage.selection.selectedIds).to.have.length.at.most(6);
    }
  });
});
