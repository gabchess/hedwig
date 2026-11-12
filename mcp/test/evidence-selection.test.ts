import { expect } from "chai";
import {
  buildFoundationRetriever,
  retrieveFoundationSources,
  type FoundationRetriever,
} from "../src/knowledge";
import { SUPPORTED_DEPLOYMENTS } from "../src/expert-request";
import {
  answerExpertRequest,
  prepareExpertRequest,
} from "../src/expert-workflow";
import type { GenerateFoundationAnswer } from "../src/foundation-answer";

type Selection = {
  limit: number;
  eligibleCandidateIds: readonly string[];
  selectedIds: readonly string[];
  omittedIds: readonly string[];
  omissionReason: "source_limit" | null;
};
type Diagnostics = {
  scope: string;
  diagnosticsComplete: boolean;
  stages: Array<{
    stage: string;
    deploymentId?: string;
    diagnostics: string;
    selection?: Selection;
  }>;
  contextSourceIds: readonly string[];
};
function diagnosticsOf(result: unknown): Diagnostics {
  expect(result).to.have.property("evidenceSelection");
  return (result as { evidenceSelection: Diagnostics }).evidenceSelection;
}
function fixtureRetriever() {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  return buildFoundationRetriever({
    schemaVersion: 1,
    sources: [
      {
        sourceId: "fixture",
        title: "Fixture",
        url: "https://example.test/source",
        sourceFileUrl: `https://github.com/example/source/blob/${commit}/source.md`,
        revision: `example/source@${commit}`,
        blobSha: "1".repeat(40),
        license: "MIT",
        licenseUrl: `https://github.com/example/source/blob/${commit}/LICENSE`,
        licenseBlobSha: "2".repeat(40),
        chunks: ["a", "b", "c", "d", "quiet"].map((id) => ({
          id,
          topics: [id === "d" ? "Other" : "Protocol"],
          keywords: [],
          text:
            id === "quiet"
              ? "Unrelated material."
              : "Alpha complete evidence sentence.",
        })),
      },
    ],
  });
}
const comparison = {
  mode: "compare",
  question: "Compare lending collateral borrowing supply liquidation interest.",
  deployments: SUPPORTED_DEPLOYMENTS.map(({ chainId, address }) => ({
    chainId,
    address,
  })),
};
const withoutCallback: FoundationRetriever = (question, options) =>
  retrieveFoundationSources(question, {
    topics: options?.topics,
    excludeTopics: options?.excludeTopics,
    excludeIds: options?.excludeIds,
    limit: options?.limit,
  });

describe("per-stage evidence selection diagnostics", () => {
  it("accounts for every positive ranked candidate after filters without truncating evidence", () => {
    const retrieve = fixtureRetriever();
    let reported: Selection | undefined;
    const sources = retrieve("alpha", {
      limit: 2,
      onSelection: (selection: Selection) => {
        reported = selection;
      },
    });
    expect(reported).to.deep.equal({
      limit: 2,
      eligibleCandidateIds: ["a", "b", "c", "d"],
      selectedIds: ["a", "b"],
      omittedIds: ["c", "d"],
      omissionReason: "source_limit",
    });
    expect(sources.map(({ text }) => text)).to.deep.equal([
      "Alpha complete evidence sentence.",
      "Alpha complete evidence sentence.",
    ]);
    retrieve("alpha", {
      topics: ["Protocol", "Other"],
      excludeTopics: ["Other"],
      excludeIds: ["b"],
      limit: 1,
      onSelection: (selection: Selection) => {
        reported = selection;
      },
    });
    expect(reported).to.deep.equal({
      limit: 1,
      eligibleCandidateIds: ["a", "c"],
      selectedIds: ["a"],
      omittedIds: ["c"],
      omissionReason: "source_limit",
    });
  });

  it("reports no limit omission for all selected, zero-match, and stopword-only valid queries", () => {
    const retrieve = fixtureRetriever();
    for (const [question, ids] of [
      ["alpha", ["a", "b", "c", "d"]],
      ["unfindable", []],
      ["the and", []],
    ] as const) {
      let reported: Selection | undefined;
      const selected = retrieve(question, {
        limit: 9,
        onSelection: (selection: Selection) => {
          reported = selection;
        },
      });
      expect(reported).to.deep.equal({
        limit: 9,
        eligibleCandidateIds: ids,
        selectedIds: ids,
        omittedIds: [],
        omissionReason: null,
      });
      expect(selected.map(({ id }) => id)).to.deep.equal(ids);
    }
  });

  it("gives the callback detached frozen metadata that cannot alter selected evidence", () => {
    const retrieve = fixtureRetriever();
    let seen: Selection | undefined;
    const selected = retrieve("alpha", {
      limit: 2,
      onSelection: (selection: Selection) => {
        seen = selection;
        expect(Object.isFrozen(selection)).to.equal(true);
        for (const ids of [
          selection.eligibleCandidateIds,
          selection.selectedIds,
          selection.omittedIds,
        ]) {
          expect(Object.isFrozen(ids)).to.equal(true);
          expect(() => (ids as string[]).push("injected")).to.throw();
        }
      },
    });
    expect(selected.map(({ id }) => id)).to.deep.equal(["a", "b"]);
    expect(retrieve("alpha", { limit: 2 })).to.deep.equal(selected);
    expect(seen?.selectedIds).to.deep.equal(["a", "b"]);
  });

  it("preserves five comparison retrieval scopes and the exact final packet order", () => {
    const observed: Array<{ ids: string[]; options: unknown }> = [];
    const retrieve: FoundationRetriever = (question, options) => {
      const sources = retrieveFoundationSources(question, options);
      observed.push({ ids: sources.map(({ id }) => id), options });
      return sources;
    };
    const prepared = prepareExpertRequest(comparison, retrieve);
    if (prepared.status !== "ready" || prepared.mode !== "compare")
      throw new Error("expected comparison ready");
    const diagnostics = diagnosticsOf(prepared);
    expect(diagnostics.scope).to.equal("per_stage_positive_ranked_candidates");
    expect(diagnostics.diagnosticsComplete).to.equal(true);
    expect(
      diagnostics.stages.map(({ stage, deploymentId }) => [stage, deploymentId])
    ).to.deep.equal([
      ["identity", SUPPORTED_DEPLOYMENTS[0].id],
      ["identity", SUPPORTED_DEPLOYMENTS[1].id],
      ["mechanisms", SUPPORTED_DEPLOYMENTS[0].id],
      ["mechanisms", SUPPORTED_DEPLOYMENTS[1].id],
      ["shared", undefined],
    ]);
    diagnostics.stages.forEach(({ diagnostics: state, selection }, index) => {
      expect(state).to.equal("reported");
      if (!selection) throw new Error("missing selection");
      expect(selection.selectedIds).to.deep.equal(observed[index].ids);
      expect(selection.eligibleCandidateIds).to.deep.equal([
        ...selection.selectedIds,
        ...selection.omittedIds,
      ]);
      expect(selection.selectedIds.length).to.equal(
        Math.min(selection.limit, selection.eligibleCandidateIds.length)
      );
    });
    expect(
      diagnostics.stages.some(
        ({ selection }) => selection!.omittedIds.length > 0
      )
    ).to.equal(true);
    expect(diagnostics.contextSourceIds).to.deep.equal(
      prepared.sources.map(({ id }) => id)
    );
    expect(diagnostics).not.to.have.property("omittedIds");
    const baseline = prepareExpertRequest(comparison, withoutCallback);
    if (baseline.status !== "ready" || baseline.mode !== "compare")
      throw new Error("expected baseline comparison ready");
    expect(prepared.sources).to.deep.equal(baseline.sources);
    expect(prepared.comparisonEvidence).to.deep.equal(
      baseline.comparisonEvidence
    );
  });

  it("marks injected retrievers without reports as unavailable diagnostics, not zero omissions", () => {
    const prepared = prepareExpertRequest(comparison, withoutCallback);
    const diagnostics = diagnosticsOf(prepared);
    expect(diagnostics.diagnosticsComplete).to.equal(false);
    expect(diagnostics.stages).to.have.length(5);
    diagnostics.stages.forEach((stage) => {
      expect(stage.diagnostics).to.equal("unavailable");
      expect(stage).not.to.have.property("selection");
    });
  });

  it("does not trust inconsistent or repeated callback reports or retain mutable report arrays", () => {
    for (const variant of [
      "wrong-selected",
      "wrong-prefix",
      "wrong-limit",
      "wrong-reason",
      "repeated",
      "valid",
    ] as const) {
      const report: Selection = {
        limit: 9,
        eligibleCandidateIds: ["a", "b", "c", "d"],
        selectedIds: ["a", "b", "c", "d"],
        omittedIds: [],
        omissionReason: null,
      };
      if (variant === "wrong-selected") report.selectedIds = ["unreturned"];
      if (variant === "wrong-prefix")
        report.eligibleCandidateIds = ["b", "a", "c", "d"];
      if (variant === "wrong-limit") report.limit = 1;
      if (variant === "wrong-reason") report.omissionReason = "source_limit";
      const retrieve: FoundationRetriever = (question, options) => {
        const selected = fixtureRetriever()(question, {
          limit: options?.limit,
        });
        options?.onSelection?.(report);
        if (variant === "repeated") options?.onSelection?.(report);
        return selected;
      };
      const prepared = prepareExpertRequest(
        { question: "alpha", mode: "learn" },
        retrieve
      );
      const diagnostics = diagnosticsOf(prepared);
      expect(diagnostics.diagnosticsComplete).to.equal(variant === "valid");
      if (prepared.status !== "ready") throw new Error("expected ready");
      expect(prepared.sources.map(({ id }) => id)).to.deep.equal([
        "a",
        "b",
        "c",
        "d",
      ]);
      (report.selectedIds as string[]).push("later-mutation");
      if (variant === "valid")
        expect(diagnostics.stages[0].selection?.selectedIds).to.deep.equal([
          "a",
          "b",
          "c",
          "d",
        ]);
      else expect(diagnostics.stages[0]).not.to.have.property("selection");
    }
  });

  it("keeps diagnostics out of generation input and preserves every selected evidence byte", async () => {
    const inputs: Parameters<GenerateFoundationAnswer>[0][] = [];
    const generate: GenerateFoundationAnswer = async (input) => {
      inputs.push(input);
      return {
        answer: "Documented account balance.",
        citationIds: [input.sources[0].id],
        unsupportedParts: [],
      };
    };
    const request = {
      question: "What is the balance of an Ethereum account?",
      mode: "learn",
    };
    const result = await answerExpertRequest(
      request,
      retrieveFoundationSources,
      generate
    );
    await answerExpertRequest(request, withoutCallback, generate);
    expect(result.status).to.equal("answered");
    expect(inputs[0]).to.deep.equal(inputs[1]);
    expect(inputs[0]).not.to.have.property("evidenceSelection");
    const diagnostics = diagnosticsOf(result);
    expect(diagnostics.diagnosticsComplete).to.equal(true);
    expect(diagnostics.contextSourceIds).to.deep.equal(
      inputs[0].sources.map(({ id }) => id)
    );
    expect(JSON.stringify(diagnostics)).not.to.include(request.question);
    for (const source of inputs[0].sources)
      expect(JSON.stringify(diagnostics)).not.to.include(source.text);
  });

  it("retains completed retrieval diagnostics after generation failure or insufficient evidence", async () => {
    const unavailable = await answerExpertRequest(
      { question: "Ethereum account balance", mode: "learn" },
      retrieveFoundationSources,
      async () => {
        throw new Error("provider unavailable");
      }
    );
    expect(unavailable.status).to.equal("unavailable");
    expect(diagnosticsOf(unavailable).diagnosticsComplete).to.equal(true);
    const insufficient = await answerExpertRequest(
      { question: "unfindable", mode: "learn" },
      fixtureRetriever(),
      async () => {
        throw new Error("must not generate");
      }
    );
    expect(insufficient.status).to.equal("insufficient_evidence");
    expect(diagnosticsOf(insufficient).contextSourceIds).to.deep.equal([]);
    expect(diagnosticsOf(insufficient).diagnosticsComplete).to.equal(true);
    const identityMissing = prepareExpertRequest(
      comparison,
      fixtureRetriever()
    );
    expect(identityMissing.status).to.equal("insufficient_evidence");
    expect(diagnosticsOf(identityMissing).stages).to.have.length(1);
    expect(diagnosticsOf(identityMissing).contextSourceIds).to.deep.equal([]);
    expect(
      prepareExpertRequest(
        { mode: "compare", question: "Compare mechanisms" },
        retrieveFoundationSources
      )
    ).not.to.have.property("evidenceSelection");
  });
});
