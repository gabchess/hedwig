import { MAX_LEARNING_QUESTION_CHARS } from "./expert";
import type { DeploymentSnapshot } from "./expert-request";
import type {
  FoundationAnswer,
  FoundationEvidence,
  GenerateFoundationAnswer,
} from "./foundation-answer";
import {
  MAX_ANSWER_CHARS,
  MAX_UNSUPPORTED_PARTS,
  MAX_UNSUPPORTED_PART_CHARS,
  validateFoundationContent,
  type FoundationProvenance,
  type ValidatedFoundationContent,
} from "./foundation-content";

export type ComparisonEvidence = {
  readonly byDeployment: Readonly<Record<string, readonly string[]>>;
  readonly sharedSourceIds: readonly string[];
};

export type ComparisonContext = {
  readonly deployments: readonly DeploymentSnapshot[];
  readonly liveStateVerified: false;
  readonly limitation: string;
  readonly evidence: ComparisonEvidence;
};

const COMPARISON_DEPLOYMENT_COUNT = 2;
const OUTPUT_FIELDS = ["sections"];
const SECTION_FIELDS = [
  "requested",
  "answer",
  "citationIds",
  "unsupportedParts",
];

type ComparisonSection =
  | { requested: false }
  | { requested: true; content: ValidatedFoundationContent };

function exactObject(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function copyContext(context: ComparisonContext): ComparisonContext {
  return {
    ...context,
    deployments: context.deployments.map((deployment) => ({ ...deployment })),
    evidence: {
      byDeployment: Object.fromEntries(
        Object.entries(context.evidence.byDeployment).map(([id, sourceIds]) => [
          id,
          [...sourceIds],
        ])
      ),
      sharedSourceIds: [...context.evidence.sharedSourceIds],
    },
  };
}

/** Scope is model-declared; this validates its shape, not requested-part coverage. */
function validateComparisonSection(
  raw: unknown,
  sources: readonly FoundationEvidence[]
): ComparisonSection | undefined {
  if (!exactObject(raw, SECTION_FIELDS) || typeof raw.requested !== "boolean")
    return undefined;
  const { requested, ...content } = raw;
  if (!requested) {
    return content.answer === "" &&
      Array.isArray(content.citationIds) &&
      content.citationIds.length === 0 &&
      Array.isArray(content.unsupportedParts) &&
      content.unsupportedParts.length === 0
      ? { requested: false }
      : undefined;
  }
  const validated = validateFoundationContent(content, sources);
  return validated ? { requested: true, content: validated } : undefined;
}

/** One generation, two independently scoped sections; formatting grants no semantic authority. */
export async function answerComparisonFromSources(
  question: string,
  sources: readonly FoundationEvidence[],
  comparison: ComparisonContext,
  generate: GenerateFoundationAnswer,
  signal?: AbortSignal
): Promise<FoundationAnswer> {
  if (
    typeof question !== "string" ||
    !question.trim() ||
    question.length > MAX_LEARNING_QUESTION_CHARS
  )
    return { status: "invalid_question" };
  if (signal?.aborted) return { status: "unavailable" };
  const trusted = copyContext(comparison);
  const trustedSources = sources.map((source) => ({ ...source }));
  const ids = trusted.deployments.map((deployment) => deployment.id);
  const sourceIds = new Set(trustedSources.map((source) => source.id));
  if (
    ids.length !== COMPARISON_DEPLOYMENT_COUNT ||
    new Set(ids).size !== COMPARISON_DEPLOYMENT_COUNT ||
    !exactObject(trusted.evidence.byDeployment, ids) ||
    ids.some((id) => trusted.evidence.byDeployment[id].length === 0) ||
    [
      ...Object.values(trusted.evidence.byDeployment).flat(),
      ...trusted.evidence.sharedSourceIds,
    ].some((id) => !sourceIds.has(id))
  )
    return { status: "insufficient_evidence" };
  try {
    const raw = await generate({
      question,
      sources: trustedSources.map((source) => ({ ...source })),
      comparison: copyContext(trusted),
      signal,
    });
    if (signal?.aborted) return { status: "unavailable" };
    if (!exactObject(raw, OUTPUT_FIELDS) || !exactObject(raw.sections, ids))
      return { status: "insufficient_evidence" };
    const sections: string[] = [];
    const unsupportedParts: string[] = [];
    const cited = new Map<string, FoundationProvenance>();
    for (const deployment of trusted.deployments) {
      const allowed = new Set([
        ...trusted.evidence.byDeployment[deployment.id],
        ...trusted.evidence.sharedSourceIds,
      ]);
      const section = validateComparisonSection(
        raw.sections[deployment.id],
        trustedSources.filter((source) => allowed.has(source.id))
      );
      if (!section) return { status: "insufficient_evidence" };
      if (!section.requested) continue;
      const content = section.content;
      if (content.answer)
        sections.push(`${deployment.name}:\n${content.answer}`);
      for (const source of content.sources) cited.set(source.id, source);
      unsupportedParts.push(
        ...content.unsupportedParts.map((part) => `${deployment.name}: ${part}`)
      );
    }
    const answer = sections.join("\n\n");
    if (
      answer.length > MAX_ANSWER_CHARS ||
      unsupportedParts.length > MAX_UNSUPPORTED_PARTS ||
      unsupportedParts.some((part) => part.length > MAX_UNSUPPORTED_PART_CHARS)
    )
      return { status: "insufficient_evidence" };
    if (!answer) return { status: "insufficient_evidence", unsupportedParts };
    return {
      status: unsupportedParts.length ? "partial" : "answered",
      answer,
      sources: [...cited.values()],
      unsupportedParts,
    };
  } catch {
    return { status: "unavailable" };
  }
}
