import {
  answerFromFoundationSources,
  type GenerateFoundationAnswer,
} from "./foundation-answer";
import { parseExpertRequest } from "./expert-request";
import { answerComparisonFromSources } from "./comparison-answer";
import type { FoundationRetriever, FoundationSource } from "./knowledge";

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

/** The runtime and evaluator share the same identity and evidence preparation. */
export function prepareExpertRequest(
  input: unknown,
  retrieve: FoundationRetriever
) {
  const request = parseExpertRequest(input);
  if (request.status !== "ready") return request;
  if (request.mode === "learn") {
    return {
      ...request,
      sources: retrieve(request.question, { limit: LEARNING_SOURCES }),
      comparison: undefined,
    };
  }
  const deployments = request.deployments;
  const evidence = new Map<string, FoundationSource>();
  const byDeployment: Record<string, string[]> = {};
  for (const deployment of deployments) {
    const identity = retrieve(deployment.address).find(
      (source) => source.id === IDENTITY_SOURCE_IDS[deployment.id]
    );
    if (!identity || identity.sourceFileUrl !== deployment.sourceFileUrl) {
      return { status: "insufficient_evidence" as const };
    }
    evidence.set(identity.id, identity);
    byDeployment[deployment.id] = [identity.id];
  }
  const identitySourceIds = new Set(evidence.keys());
  const candidates = deployments.map((deployment) =>
    retrieve(request.question, {
      topics: [DEPLOYMENT_TOPICS[deployment.id]],
      excludeIds: [...evidence.keys()],
      limit: MECHANISM_SOURCES_PER_DEPLOYMENT,
    }).slice(0, MECHANISM_SOURCES_PER_DEPLOYMENT)
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
  for (const source of retrieve(request.question, {
    excludeTopics: deployments.map(
      (deployment) => DEPLOYMENT_TOPICS[deployment.id]
    ),
    excludeIds: [...evidence.keys()],
    limit: SHARED_CONTEXT_SOURCES,
  }).slice(0, SHARED_CONTEXT_SOURCES)) {
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
    return { ...result, sources: [...sources.values()], comparison };
  }
  return result;
}
