import {
  answerFromFoundationSources,
  type GenerateFoundationAnswer,
} from "./foundation-answer";
import { parseExpertRequest } from "./expert-request";
import { answerComparisonFromSources } from "./comparison-answer";
import type {
  FoundationRetriever,
  FoundationRetrievalOptions,
  FoundationSelection,
  FoundationSource,
} from "./knowledge";

const IDENTITY_SOURCE_IDS: Readonly<Record<string, string>> = Object.freeze({
  "aave-v3-ethereum": "aave-v3-ethereum-identity",
  "compound-iii-ethereum-usdc": "compound-iii-ethereum-usdc-identity",
});
const DEPLOYMENT_TOPICS: Readonly<Record<string, string>> = Object.freeze({
  "aave-v3-ethereum": "Aave V3",
  "compound-iii-ethereum-usdc": "Compound III",
});
const LEARNING_SOURCES = 9;
const MAX_COMPARISON_SOURCES = 16;
const MECHANISM_SOURCES_PER_DEPLOYMENT = 6;
const SHARED_CONTEXT_SOURCES = 2;

type SelectionStage = Readonly<
  | { stage: "learn" | "shared" }
  | { stage: "identity" | "mechanisms"; deploymentId: string }
>;
type StageSelection = SelectionStage &
  Readonly<
    | { diagnostics: "reported"; selection: FoundationSelection }
    | { diagnostics: "unavailable" }
  >;
export type EvidenceSelection = Readonly<{
  scope: "per_stage_positive_ranked_candidates";
  /** Completeness of retrieval diagnostics only, never answer support. */
  diagnosticsComplete: boolean;
  stages: readonly StageSelection[];
  /** Final context order; a stage omission may be selected by another stage. */
  contextSourceIds: readonly string[];
}>;

function copySelection(
  value: FoundationSelection
): FoundationSelection | undefined {
  if (
    !value ||
    ![value.eligibleCandidateIds, value.selectedIds, value.omittedIds].every(
      (ids) =>
        Array.isArray(ids) &&
        ids.every((id) => typeof id === "string" && id.length > 0)
    )
  )
    return undefined;
  return Object.freeze({
    limit: value.limit,
    eligibleCandidateIds: Object.freeze([...value.eligibleCandidateIds]),
    selectedIds: Object.freeze([...value.selectedIds]),
    omittedIds: Object.freeze([...value.omittedIds]),
    omissionReason: value.omissionReason,
  });
}

function matchesSelection(
  selection: FoundationSelection | undefined,
  sources: readonly FoundationSource[],
  requestedLimit?: number
): selection is FoundationSelection {
  if (!selection) return false;
  const {
    limit,
    eligibleCandidateIds,
    selectedIds,
    omittedIds,
    omissionReason,
  } = selection;
  const accounted = [...selectedIds, ...omittedIds];
  return (
    Number.isSafeInteger(limit) &&
    limit >= 1 &&
    limit <= 9 &&
    (requestedLimit === undefined || limit === requestedLimit) &&
    new Set(eligibleCandidateIds).size === eligibleCandidateIds.length &&
    eligibleCandidateIds.length === accounted.length &&
    eligibleCandidateIds.every((id, index) => id === accounted[index]) &&
    selectedIds.length === Math.min(limit, eligibleCandidateIds.length) &&
    sources.length === selectedIds.length &&
    sources.every((source, index) => source.id === selectedIds[index]) &&
    omissionReason === (omittedIds.length > 0 ? "source_limit" : null)
  );
}

/** Per-call metadata stays separate from evidence and never enters generation. */
function selectionDiagnostics(retrieve: FoundationRetriever) {
  const stages: StageSelection[] = [];
  return {
    retrieve(
      stage: SelectionStage,
      question: string,
      options?: FoundationRetrievalOptions
    ) {
      let report: FoundationSelection | undefined;
      let reports = 0;
      const sources = retrieve(question, {
        ...options,
        onSelection: (selection) => {
          reports++;
          report = copySelection(selection);
        },
      });
      stages.push(
        Object.freeze(
          reports === 1 && matchesSelection(report, sources, options?.limit)
            ? { ...stage, diagnostics: "reported" as const, selection: report }
            : { ...stage, diagnostics: "unavailable" as const }
        )
      );
      return sources;
    },
    snapshot(contextSourceIds: readonly string[]): EvidenceSelection {
      return Object.freeze({
        scope: "per_stage_positive_ranked_candidates",
        diagnosticsComplete: stages.every(
          (stage) => stage.diagnostics === "reported"
        ),
        stages: Object.freeze([...stages]),
        contextSourceIds: Object.freeze([...contextSourceIds]),
      });
    },
  };
}

/** The runtime and evaluator share the same identity and evidence preparation. */
export function prepareExpertRequest(
  input: unknown,
  retrieve: FoundationRetriever
) {
  const request = parseExpertRequest(input);
  if (request.status !== "ready") return request;
  const selection = selectionDiagnostics(retrieve);
  if (request.mode === "learn") {
    const sources = selection.retrieve({ stage: "learn" }, request.question, {
      limit: LEARNING_SOURCES,
    });
    return {
      ...request,
      sources,
      comparison: undefined,
      evidenceSelection: selection.snapshot(sources.map((source) => source.id)),
    };
  }
  const deployments = request.deployments;
  const evidence = new Map<string, FoundationSource>();
  const byDeployment: Record<string, string[]> = {};
  for (const deployment of deployments) {
    const identity = selection
      .retrieve(
        { stage: "identity", deploymentId: deployment.id },
        deployment.address
      )
      .find((source) => source.id === IDENTITY_SOURCE_IDS[deployment.id]);
    if (!identity || identity.sourceFileUrl !== deployment.sourceFileUrl) {
      return {
        status: "insufficient_evidence" as const,
        evidenceSelection: selection.snapshot([]),
      };
    }
    evidence.set(identity.id, identity);
    byDeployment[deployment.id] = [identity.id];
  }
  const identitySourceIds = new Set(evidence.keys());
  const candidates = deployments.map((deployment) =>
    selection
      .retrieve(
        { stage: "mechanisms", deploymentId: deployment.id },
        request.question,
        {
          topics: [DEPLOYMENT_TOPICS[deployment.id]],
          excludeIds: [...evidence.keys()],
          limit: MECHANISM_SOURCES_PER_DEPLOYMENT,
        }
      )
      .slice(0, MECHANISM_SOURCES_PER_DEPLOYMENT)
  );
  // Round-robin allocation prevents one protocol's evidence from taking the
  // entire comparison context. Identity evidence has reserved slots above.
  for (
    let rank = 0;
    rank < MECHANISM_SOURCES_PER_DEPLOYMENT &&
    evidence.size < MAX_COMPARISON_SOURCES;
    rank++
  ) {
    for (const [index, ranked] of candidates.entries()) {
      const source = ranked[rank];
      if (
        source &&
        !identitySourceIds.has(source.id) &&
        evidence.size < MAX_COMPARISON_SOURCES
      ) {
        evidence.set(source.id, source);
        // Membership comes from the selected deployment's retrieval call.
        byDeployment[deployments[index].id].push(source.id);
      }
    }
  }
  // A shared token, issuer, chain or bridge can introduce risk outside either
  // protocol's own documentation. Keep dedicated slots for those sources.
  const sharedSourceIds: string[] = [];
  for (const source of selection
    .retrieve({ stage: "shared" }, request.question, {
      excludeTopics: deployments.map(
        (deployment) => DEPLOYMENT_TOPICS[deployment.id]
      ),
      excludeIds: [...evidence.keys()],
      limit: SHARED_CONTEXT_SOURCES,
    })
    .slice(0, SHARED_CONTEXT_SOURCES)) {
    if (evidence.size < MAX_COMPARISON_SOURCES && !evidence.has(source.id)) {
      evidence.set(source.id, source);
      sharedSourceIds.push(source.id);
    }
  }
  const comparison = {
    deployments,
    liveStateVerified: false as const,
    limitation:
      "Repository deployment and mechanism snapshots; current implementation, parameters, yield, liquidity and safety have not been verified.",
  };
  return {
    ...request,
    sources: [...evidence.values()],
    comparison,
    comparisonEvidence: { byDeployment, sharedSourceIds },
    evidenceSelection: selection.snapshot([...evidence.keys()]),
  };
}

/** Compose a bounded educational run after deterministic request/identity checks. */
export async function answerExpertRequest(
  input: unknown,
  retrieve: FoundationRetriever,
  generate: GenerateFoundationAnswer,
  signal?: AbortSignal
) {
  if (signal?.aborted) return { status: "unavailable" as const };
  const request = prepareExpertRequest(input, retrieve);
  if (request.status !== "ready") return request;
  const comparison = request.comparison;
  const result =
    request.mode === "compare"
      ? await answerComparisonFromSources(
          request.question,
          request.sources,
          { ...request.comparison, evidence: request.comparisonEvidence },
          generate,
          signal
        )
      : await answerFromFoundationSources(
          request.question,
          request.sources,
          generate,
          signal
        );
  if (result.status === "unavailable") {
    return {
      ...result,
      availableSources: request.sources.map(
        ({ text: _text, ...reference }) => reference
      ),
      ...(comparison ? { comparison } : {}),
      evidenceSelection: request.evidenceSelection,
    };
  }
  if (
    comparison &&
    (result.status === "answered" || result.status === "partial")
  ) {
    // Identity records support the application's trusted comparison metadata,
    // even when the generated prose cites only mechanism evidence.
    const identityIds = new Set(
      comparison.deployments.map(
        (deployment) => IDENTITY_SOURCE_IDS[deployment.id]
      )
    );
    const identities = request.sources
      .filter((source) => identityIds.has(source.id))
      .map(({ text: _text, ...reference }) => reference);
    const sources = new Map(
      [...identities, ...result.sources].map((source) => [source.id, source])
    );
    return {
      ...result,
      sources: [...sources.values()],
      comparison,
      evidenceSelection: request.evidenceSelection,
    };
  }
  return { ...result, evidenceSelection: request.evidenceSelection };
}
