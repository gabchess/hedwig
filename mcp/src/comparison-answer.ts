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

function scopeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A comparison requires the selected pair unless the caller explicitly narrows
 * it with a recognized only-instruction naming one deployment. This bounded
 * grammar is not a general interpretation of prose; ambiguity retains the pair.
 */
function requestedDeploymentIds(
  question: string,
  deployments: readonly DeploymentSnapshot[]
): ReadonlySet<string> {
  const all = new Set(deployments.map(({ id }) => id));
  const text = scopeText(question);
  if (/\b(?:compare|contrast|comparar|comparando|contraste)\b/.test(text))
    return all;
  if (
    /\b(?:both|each|two|ambos|ambas|cada|dois|duas)\s+(?:(?:selected|supplied|selecionados|informados)\s+)?(?:deployments?|protocols?|mechanisms?|protocolos?|mecanismos?)\b(?!\s+identit(?:y|ies)\b)/.test(
      text
    )
  )
    return all;
  const names = deployments.map((deployment) => {
    const aliases = [
      deployment.id,
      deployment.name,
      deployment.address,
      ...(deployment.name.match(/\b(?:Aave|Compound|Comet)\b/gi) ?? []),
    ];
    return {
      id: deployment.id,
      pattern: aliases
        .map((alias) => escapePattern(scopeText(alias)))
        .join("|"),
    };
  });
  const action =
    "(?:explain|answer|describe|discuss|focus|cover|explique|responda|descreva|discuta|aborde|fale)";
  const instructions = new RegExp(
    `\\b(?:${action}\\s+(?:only|apenas|somente)|(?:only|apenas|somente)\\s+${action})\\s+(?:(?:about|for|on|the|sobre|o|a)\\s+)*([^.;:!?\\n]+)`,
    "g"
  );
  const excluded = new RegExp(
    `\\b(?:not|except|excluding|nao|exceto)\\s+(?:(?:the|o|a)\\s+)?(?:${names
      .map(({ pattern }) => pattern)
      .join("|")})\\b`,
    "g"
  );
  const selected = new Set<string>();
  for (const instruction of text.matchAll(instructions)) {
    const prefix = text.slice(0, instruction.index);
    // Reported/quoted words are not a caller scope declaration. Recognize only
    // a direct imperative or a new imperative clause; a colon is not sufficient.
    if (
      !/^(?:(?:please|por favor)\s+)?$/.test(prefix) &&
      !/[.;!?\n]\s*(?:(?:but|instead|please|por favor|mas)\s+)*$/.test(
        prefix
      ) &&
      !/,\s*(?:but|mas)\s+$/.test(prefix)
    )
      return all;
    const clause = instruction[1].replace(excluded, "");
    const matching = names.filter(({ pattern }) =>
      new RegExp(`\\b(?:${pattern})\\b`).test(clause)
    );
    if (
      matching.length !== 1 ||
      !new RegExp(`^(?:${matching[0].pattern})\\b`).test(clause)
    )
      return all;
    selected.add(matching[0].id);
  }
  if (selected.size !== 1) return all;
  const other = names.find(({ id }) => !selected.has(id))!;
  const excludedOther = new RegExp(
    `\\b(?:not|never|don't|dont|nao|except|excluding|exceto)\\s+(?:(?:${action}|about|for|on|the|sobre|o|a)\\s+)*(?:${other.pattern})\\b`,
    "g"
  );
  // Any other-side reference outside a narrow exclusion keeps the pair. This
  // also covers additional questions without classifying their possible verbs.
  if (
    new RegExp(`\\b(?:${other.pattern})\\b`).test(
      text.replace(excludedOther, "")
    )
  )
    return all;
  return selected;
}

/** Validate model-declared shape; the caller's trusted scope is checked separately. */
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
  const requestedIds = requestedDeploymentIds(question, trusted.deployments);
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
      if (!requestedIds.has(deployment.id)) {
        if (section.requested) return { status: "insufficient_evidence" };
        continue;
      }
      if (!section.requested) {
        unsupportedParts.push(
          `${deployment.name}: Requested explanation was not provided.`
        );
        continue;
      }
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
