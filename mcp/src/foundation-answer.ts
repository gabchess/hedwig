import { MAX_LEARNING_QUESTION_CHARS } from "./expert";
import type { FoundationSource } from "./knowledge";
import type { ComparisonContext } from "./comparison-answer";
import {
  validateFoundationContent,
  type FoundationProvenance,
} from "./foundation-content";

export type FoundationEvidence = FoundationSource;
export type GenerateFoundationAnswer = (input: {
  question: string;
  sources: readonly FoundationEvidence[];
  comparison?: ComparisonContext;
  signal?: AbortSignal;
}) => Promise<unknown>;

export type FoundationAnswer =
  | {
      status: "answered" | "partial";
      answer: string;
      sources: FoundationProvenance[];
      unsupportedParts: string[];
    }
  | {
      status: "insufficient_evidence";
      answer?: never;
      sources?: never;
      unsupportedParts?: string[];
    }
  | {
      status: "invalid_question" | "unavailable";
      answer?: never;
      sources?: never;
      unsupportedParts?: never;
    };

/** Validate content and citations, then derive completeness; not semantic entailment. */
export async function answerFromFoundationSources(
  question: string,
  sources: readonly FoundationEvidence[],
  generate: GenerateFoundationAnswer,
  signal?: AbortSignal
): Promise<FoundationAnswer> {
  if (
    typeof question !== "string" ||
    !question.trim() ||
    question.length > MAX_LEARNING_QUESTION_CHARS
  ) {
    return { status: "invalid_question" };
  }
  if (sources.length === 0) return { status: "insufficient_evidence" };

  const trustedSources = sources.map((source) => ({ ...source }));
  try {
    if (signal?.aborted) return { status: "unavailable" };
    const raw = await generate({
      question,
      sources: trustedSources.map((source) => ({ ...source })),
      signal,
    });
    if (signal?.aborted) return { status: "unavailable" };
    const content = validateFoundationContent(raw, trustedSources);
    if (!content) return { status: "insufficient_evidence" };
    if (!content.answer)
      return {
        status: "insufficient_evidence",
        unsupportedParts: content.unsupportedParts,
      };
    return {
      status: content.unsupportedParts.length > 0 ? "partial" : "answered",
      ...content,
    };
  } catch {
    return { status: "unavailable" };
  }
}
