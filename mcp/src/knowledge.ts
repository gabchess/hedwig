import foundationPack from "./knowledge/foundations.json";

import { MAX_LEARNING_QUESTION_CHARS } from "./expert";

export type FoundationSource = {
  id: string;
  url: string;
  sourceFileUrl: string;
  revision: string;
  title: string;
  text: string;
};

type FoundationIndexDocument = FoundationSource & {
  sourceId: string;
  topics: string[];
  keywords: string[];
  blobSha: string;
  license: string;
  licenseUrl: string;
  licenseBlobSha: string;
  tokens: string[];
  termFrequency: Map<string, number>;
};

export type FoundationRetriever = (question: string) => FoundationSource[];

const FOUNDATION_TOP_K = 5;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const IDF_OFFSET = 0.5;
const SCORE_EPSILON = 0.000000001;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "their",
  "them",
  "there",
  "this",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "would",
]);

// Keep these aliases small and symmetric. They normalize terminology for
// candidate retrieval; they do not decide whether a whole question is safe
// or supported by a returned chunk.
const TOKEN_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ["eoa", ["eoa", "externally", "owned", "account"]],
  ["eoas", ["eoa", "externally", "owned", "account"]],
  ["eth", ["eth", "ether"]],
  ["ether", ["eth", "ether"]],
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  context: string
): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`foundation ${context} requires ${field}`);
  }
  return value;
}

function requireHttpsUrl(value: string, context: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`foundation ${context} URL is invalid`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`foundation ${context} URL must use HTTPS`);
  }
}

function revisionCommit(revision: string, context: string): string {
  const match = /@([a-f0-9]{40})$/i.exec(revision);
  if (!match) {
    throw new Error(`foundation ${context} revision must pin a commit`);
  }
  return match[1].toLowerCase();
}

function requireSha(value: string, field: string, context: string): void {
  if (!/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error(`foundation ${context} ${field} must be a SHA-1 blob id`);
  }
}

function requiredStringArray(
  record: Record<string, unknown>,
  field: string,
  context: string
): string[] {
  const value = record[field];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error(`foundation ${context} requires ${field}`);
  }
  return value as string[];
}

function tokenize(value: string): string[] {
  const expandedCase = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const canonical = expandedCase.replace(/\berc[\s-]*4626\b/gi, "erc4626");
  const rawTokens = canonical.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  for (const token of rawTokens) {
    const terms = TOKEN_ALIASES.get(token) ?? [token];
    for (const term of terms) {
      if (!STOP_WORDS.has(term)) tokens.push(term);
    }
  }
  return tokens;
}

function frequencies(tokens: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const token of tokens) {
    result.set(token, (result.get(token) ?? 0) + 1);
  }
  return result;
}

function buildDocuments(pack: unknown): FoundationIndexDocument[] {
  const root = asRecord(pack);
  if (!root || root.schemaVersion !== 1 || !Array.isArray(root.sources)) {
    throw new Error("foundation pack must be schemaVersion 1 with sources");
  }

  const chunkIds = new Set<string>();
  const sourceIds = new Set<string>();
  const documents: FoundationIndexDocument[] = [];
  for (const sourceValue of root.sources) {
    const source = asRecord(sourceValue);
    if (!source) throw new Error("foundation source must be an object");

    const context = requiredString(source, "sourceId", "source");
    const sourceId = context;
    if (sourceIds.has(sourceId)) {
      throw new Error(`duplicate foundation source id: ${sourceId}`);
    }
    sourceIds.add(sourceId);
    const title = requiredString(source, "title", context);
    const url = requiredString(source, "url", context);
    const sourceFileUrl = requiredString(source, "sourceFileUrl", context);
    const revision = requiredString(source, "revision", context);
    const blobSha = requiredString(source, "blobSha", context);
    const license = requiredString(source, "license", context);
    const licenseUrl = requiredString(source, "licenseUrl", context);
    const licenseBlobSha = requiredString(source, "licenseBlobSha", context);
    const commit = revisionCommit(revision, context);

    requireHttpsUrl(url, context);
    requireHttpsUrl(sourceFileUrl, `${context} pinned source`);
    requireHttpsUrl(licenseUrl, `${context} pinned license`);
    requireSha(blobSha, "blobSha", context);
    requireSha(licenseBlobSha, "licenseBlobSha", context);
    if (!sourceFileUrl.toLowerCase().includes(`/${commit}/`)) {
      throw new Error(
        `foundation ${context} source URL is not pinned to revision`
      );
    }
    if (!licenseUrl.toLowerCase().includes(`/${commit}/`)) {
      throw new Error(
        `foundation ${context} license URL is not pinned to revision`
      );
    }
    if (!Array.isArray(source.chunks) || source.chunks.length === 0) {
      throw new Error(`foundation ${context} requires chunks`);
    }

    for (const chunkValue of source.chunks) {
      const chunk = asRecord(chunkValue);
      if (!chunk)
        throw new Error(`foundation ${context} chunk must be an object`);
      const id = requiredString(chunk, "id", context);
      if (chunkIds.has(id))
        throw new Error(`duplicate foundation chunk id: ${id}`);
      chunkIds.add(id);
      const text = requiredString(chunk, "text", id);
      const topics = requiredStringArray(chunk, "topics", id);
      const keywords = requiredStringArray(chunk, "keywords", id);
      const tokens = tokenize([title, ...topics, ...keywords, text].join(" "));

      documents.push({
        id,
        sourceId,
        url,
        sourceFileUrl,
        revision,
        title,
        text,
        topics,
        keywords,
        blobSha,
        license,
        licenseUrl,
        licenseBlobSha,
        tokens,
        termFrequency: frequencies(tokens),
      });
    }
  }
  if (documents.length === 0) {
    throw new Error("foundation pack contains no chunks");
  }
  return documents;
}

function scoreDocument(
  queryTerms: Set<string>,
  document: FoundationIndexDocument,
  documentFrequency: Map<string, number>,
  averageDocumentLength: number,
  documentCount: number
): number {
  let score = 0;
  for (const term of queryTerms) {
    const termFrequency = document.termFrequency.get(term) ?? 0;
    if (termFrequency === 0) continue;

    const frequency = documentFrequency.get(term) ?? 0;
    const inverseDocumentFrequency = Math.log(
      1 + (documentCount - frequency + IDF_OFFSET) / (frequency + IDF_OFFSET)
    );
    const lengthNormalization =
      BM25_K1 *
      (1 - BM25_B + BM25_B * (document.tokens.length / averageDocumentLength));
    score +=
      inverseDocumentFrequency *
      ((termFrequency * (BM25_K1 + 1)) / (termFrequency + lengthNormalization));
  }
  return score;
}

/** Build a deterministic BM25 candidate retriever from a validated source pack. */
export function buildFoundationRetriever(pack: unknown): FoundationRetriever {
  const documents = buildDocuments(pack);
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const document of documents) {
    totalLength += document.tokens.length;
    for (const term of new Set(document.tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const averageDocumentLength = totalLength / documents.length;

  return (question: string): FoundationSource[] => {
    if (
      typeof question !== "string" ||
      !question.trim() ||
      question.length > MAX_LEARNING_QUESTION_CHARS
    ) {
      return [];
    }
    const queryTerms = new Set(tokenize(question));
    if (queryTerms.size === 0) return [];

    const scored = documents
      .map((document) => ({
        document,
        score: scoreDocument(
          queryTerms,
          document,
          documentFrequency,
          averageDocumentLength,
          documents.length
        ),
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => {
        const difference = right.score - left.score;
        if (Math.abs(difference) > SCORE_EPSILON) return difference;
        return left.document.id < right.document.id
          ? -1
          : left.document.id > right.document.id
          ? 1
          : 0;
      })
      .slice(0, FOUNDATION_TOP_K);

    return scored.map(({ document }) => ({
      id: document.id,
      url: document.url,
      sourceFileUrl: document.sourceFileUrl,
      revision: document.revision,
      title: document.title,
      text: document.text,
    }));
  };
}

const retrieveFromFoundationPack = buildFoundationRetriever(foundationPack);

/**
 * Return the best matching reviewed chunks as candidate evidence. Ranking
 * does not establish that the whole question is supported or safe to answer.
 */
export function retrieveFoundationSources(
  question: string
): FoundationSource[] {
  return retrieveFromFoundationPack(question);
}
