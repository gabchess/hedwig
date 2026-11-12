import type { FoundationSource } from "./knowledge";

export type FoundationProvenance = Omit<FoundationSource, "text">;
export type ValidatedFoundationContent = {
  answer: string;
  sources: FoundationProvenance[];
  unsupportedParts: string[];
};

export const MAX_ANSWER_CHARS = 16000;
export const MAX_UNSUPPORTED_PARTS = 16;
export const MAX_UNSUPPORTED_PART_CHARS = 1000;
const OUTPUT_FIELDS = ["answer", "citationIds", "unsupportedParts"];

/** A valid result has cited content or an explicit abstention; never generated status. */
export function validateFoundationContent(
  raw: unknown,
  sources: readonly FoundationSource[]
): ValidatedFoundationContent | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result = raw as Record<string, unknown>;
  if (
    Object.keys(result).length !== OUTPUT_FIELDS.length ||
    OUTPUT_FIELDS.some(
      (field) => !Object.prototype.hasOwnProperty.call(result, field)
    )
  )
    return undefined;
  const eligible = new Map(
    sources.map(({ text: _text, ...provenance }) => [provenance.id, provenance])
  );
  const { answer, citationIds, unsupportedParts } = result;
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
    return undefined;
  const inlineIds = [...answer.matchAll(/\[([^\]]*)\]/g)].map(
    (match) => match[1]
  );
  if (inlineIds.some((id) => !eligible.has(id) || !citationIds.includes(id)))
    return undefined;
  const abstention =
    !answer.trim() && citationIds.length === 0 && unsupportedParts.length > 0;
  if (!abstention && (!answer.trim() || citationIds.length === 0))
    return undefined;
  return {
    answer: abstention ? "" : answer,
    sources: [...new Set(citationIds as string[])].map(
      (id) => eligible.get(id)!
    ),
    unsupportedParts: [...unsupportedParts] as string[],
  };
}
