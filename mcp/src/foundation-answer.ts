import { MAX_LEARNING_QUESTION_CHARS } from "./expert";
import type { FoundationSource } from "./knowledge";

export type FoundationEvidence = FoundationSource;
export type GenerateFoundationAnswer = (input: {
  question: string;
  sources: readonly FoundationEvidence[];
}) => Promise<unknown>;

type Provenance = Omit<FoundationEvidence, "text">;
export type FoundationAnswer =
  | {
      status: "answered" | "partial";
      answer: string;
      sources: Provenance[];
      unsupportedParts: string[];
    }
  | {
      status: "invalid_question" | "insufficient_evidence" | "unavailable";
      answer?: never;
      sources?: never;
      unsupportedParts?: never;
    };

const MAX_ANSWER_CHARS = 16000;
const MAX_UNSUPPORTED_PARTS = 16;
const MAX_UNSUPPORTED_PART_CHARS = 1000;
const OUTPUT_FIELDS = ["status", "answer", "citationIds", "unsupportedParts"];

/** Validate output shape and citation membership, not semantic entailment. */
export async function answerFromFoundationSources(
  question: string,
  sources: readonly FoundationEvidence[],
  generate: GenerateFoundationAnswer
): Promise<FoundationAnswer> {
  if (
    typeof question !== "string" ||
    !question.trim() ||
    question.length > MAX_LEARNING_QUESTION_CHARS
  ) {
    return { status: "invalid_question" };
  }
  if (sources.length === 0) return { status: "insufficient_evidence" };

  const eligible = new Map(
    sources.map(({ text: _text, ...provenance }) => [provenance.id, provenance])
  );
  try {
    const raw = await generate({
      question,
      sources: sources.map((source) => ({ ...source })),
    });
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return { status: "insufficient_evidence" };
    const result = raw as Record<string, unknown>;
    if (
      Object.keys(result).length !== OUTPUT_FIELDS.length ||
      OUTPUT_FIELDS.some(
        (field) => !Object.prototype.hasOwnProperty.call(result, field)
      )
    )
      return { status: "insufficient_evidence" };
    const { status, answer, citationIds, unsupportedParts } = result;
    if (
      typeof answer !== "string" ||
      answer.length > MAX_ANSWER_CHARS ||
      !Array.isArray(citationIds) ||
      citationIds.length > sources.length ||
      [...citationIds].some(
        (id) => typeof id !== "string" || !eligible.has(id)
      ) ||
      !Array.isArray(unsupportedParts) ||
      unsupportedParts.length > MAX_UNSUPPORTED_PARTS ||
      [...unsupportedParts].some(
        (part) =>
          typeof part !== "string" ||
          !part.trim() ||
          part.length > MAX_UNSUPPORTED_PART_CHARS
      )
    )
      return { status: "insufficient_evidence" };
    const inlineIds = [...answer.matchAll(/\[([A-Za-z0-9_.:-]+)\]/g)].map(
      (match) => match[1]
    );
    if (
      inlineIds.some((id) => !eligible.has(id) || !citationIds.includes(id))
    ) {
      return { status: "insufficient_evidence" };
    }
    if (status === "insufficient_evidence")
      return { status: "insufficient_evidence" };
    if (
      (status !== "answered" && status !== "partial") ||
      !answer.trim() ||
      citationIds.length === 0 ||
      (status === "answered" && unsupportedParts.length !== 0) ||
      (status === "partial" && unsupportedParts.length === 0)
    )
      return { status: "insufficient_evidence" };
    return {
      status,
      answer,
      sources: [...new Set(citationIds as string[])].map(
        (id) => eligible.get(id)!
      ),
      unsupportedParts: [...unsupportedParts] as string[],
    };
  } catch {
    return { status: "unavailable" };
  }
}
