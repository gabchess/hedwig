export const MAX_LEARNING_QUESTION_CHARS = 4000;

/** A small, operator-reviewed reference set for the learning prototype. */
const references = [
  {
    id: "erc4626-shares",
    url: "https://eips.ethereum.org/EIPS/eip-4626#specification",
    terms: ["vault share", "vault shares", "erc-4626", "erc4626"],
    text: "ERC-4626 vault shares represent a claim on a fraction of the vault's underlying holdings. The standard distinguishes ideal asset/share conversions from previews and actual deposits or withdrawals.",
  },
  {
    id: "x402-roles",
    url: "https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md",
    terms: ["x402", "http 402"],
    text: "The x402 V2 specification defines payment requirements and payment payloads. A facilitator may verify payment authorization and settle payment on behalf of a resource server.",
  },
] as const;

// This seed prototype supports only these reviewed learning intents. Citation
// membership limits the returned source set; it does not verify answer meaning.
const reviewedLearningIntents: ReadonlyMap<string, readonly string[]> = new Map(
  [
    ["what are erc-4626 vault shares", ["erc4626-shares"]],
    ["what do erc-4626 vault shares represent", ["erc4626-shares"]],
    ["what is the facilitator role in x402", ["x402-roles"]],
    ["what can an x402 v2 facilitator do", ["x402-roles"]],
  ]
);

export const reviewedLearningQuestions = [
  ...reviewedLearningIntents.keys(),
].map((question) => `${question}?`);

function normalizeReviewedQuestion(question: string): string {
  return question
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\?+$/, "")
    .trim()
    .toLowerCase();
}

export type ExpertSource = { id: string; url: string; text: string };

export type GenerateAnswer = (input: {
  question: string;
  sources: readonly ExpertSource[];
}) => Promise<{ answer: string; citationIds: string[] }>;

export async function answerLearningQuestion(
  question: string,
  generate: GenerateAnswer
) {
  if (
    typeof question !== "string" ||
    !question.trim() ||
    question.length > MAX_LEARNING_QUESTION_CHARS
  ) {
    return { status: "invalid_question" } as const;
  }
  const eligibleSourceIds = reviewedLearningIntents.get(
    normalizeReviewedQuestion(question)
  );
  if (!eligibleSourceIds) {
    return { status: "insufficient_evidence" } as const;
  }

  const sources = references
    .filter(({ id }) => eligibleSourceIds.includes(id))
    .map(({ id, url, text }) => ({ id, url, text }));

  if (sources.length === 0) {
    return { status: "insufficient_evidence" } as const;
  }

  // Take the eligible citation set before handing context to the adapter.
  const eligible = new Map<string, { id: string; url: string }>(
    sources.map(({ id, url }) => [id, { id, url }])
  );
  try {
    const result = await generate({ question, sources });
    if (
      typeof result.answer !== "string" ||
      !result.answer.trim() ||
      !Array.isArray(result.citationIds) ||
      !result.citationIds.length ||
      result.citationIds.some((id) => !eligible.has(id))
    ) {
      return { status: "insufficient_evidence" } as const;
    }
    return {
      status: "answered",
      answer: result.answer,
      sources: [...new Set(result.citationIds)].map((id) => eligible.get(id)!),
    } as const;
  } catch {
    return { status: "unavailable" } as const;
  }
}
