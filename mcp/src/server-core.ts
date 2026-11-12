import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import type { ConsultResponse } from "@hedwig/consult";

import {
  answerLearningQuestion,
  reviewedLearningQuestions,
  MAX_LEARNING_QUESTION_CHARS,
  type GenerateAnswer,
} from "./expert";
import type { GenerateFoundationAnswer } from "./foundation-answer";
import { answerExpertRequest } from "./expert-workflow";
import type { FoundationRetriever } from "./knowledge";
import { handleConsult, unknownAdapterResponse } from "./handler";
import type { PolicyPin } from "./policy";

const CONSULT_TOOL_NAME = "consult";
const LEARNING_TOOL_NAME = "ask_hedwig";
const CONSULT_TOOL_DESCRIPTION =
  "Hedwig is the eval gate your payment agent checks before it transacts. The local checker evaluates payment and swap proposals against the owner's policy and returns a verdict, a 0-to-1 support score for evidence coverage (not safety probability), and each check's result and reason. It does not sign or submit transactions; the caller controls execution and should act only on 'proceed'.";
const LEARNING_TOOL_DESCRIPTION =
  "Ask Hedwig about a small set of reviewed learning topics. Answers use the supplied references. This seed prototype does not provide broad educational coverage or verify current conditions. Supported questions: " +
  reviewedLearningQuestions
    .map((question) => JSON.stringify(question))
    .join("; ") +
  ". Case, whitespace and final question marks may vary. Other wording returns insufficient_evidence.";

const FOUNDATIONS_TOOL_DESCRIPTION =
  "Ask Hedwig educational questions about Ethereum accounts, Solana, DeFi mechanisms and risks, ERC-4626 vaults, and x402 v2 payments. Use mode=compare and two exact chainId/address deployments for the supported Aave V3 Ethereum and Compound III Ethereum USDC snapshot comparison; missing identities return needs_clarification. Answers cite retrieved, versioned reference summaries and may answer only supported parts. This corpus does not establish current balances, yields, deployment safety, or permission to transact.";

export type KnowledgeMode = "seed" | "foundations";
export function resolveKnowledgeMode(value: string | undefined): KnowledgeMode {
  const mode = value === undefined ? "seed" : value.trim();
  if (mode === "seed" || mode === "foundations") return mode;
  throw new Error("HEDWIG_KNOWLEDGE_MODE must be seed or foundations");
}

export type HedwigMode = "consult" | "education" | "both";

export type HedwigServerConfig = {
  mode: HedwigMode;
  policyPath?: string;
  policyPin?: PolicyPin;
  generate?: GenerateAnswer;
  knowledgeMode?: KnowledgeMode;
  generateFoundations?: GenerateFoundationAnswer;
};

export function resolveHedwigMode(value: string | undefined): HedwigMode {
  const mode = value === undefined ? "consult" : value.trim();
  if (mode === "consult" || mode === "education" || mode === "both") {
    return mode;
  }
  throw new Error("HEDWIG_MODE must be consult, education, or both");
}

function readToolCall(params: unknown): { name: unknown; args: unknown } {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return { name: undefined, args: undefined };
  }
  const record = params as Record<string, unknown>;
  return { name: record.name, args: record.arguments };
}

function invalidLearningArguments(args: unknown): boolean {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return true;
  }
  const record = args as Record<string, unknown>;
  return (
    Object.keys(record).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(record, "question") ||
    typeof record.question !== "string"
  );
}

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function logVerdict(result: ConsultResponse): void {
  const floorIds = new Set(result.floorIds);
  const named = result.results.filter((entry) => floorIds.has(entry.id));
  const parts = named.map((entry) => `${entry.id}:${entry.status}`);
  const extraCount = result.results.length - named.length;
  if (extraCount > 0) {
    parts.push(`extra:${extraCount}`);
  }
  console.error(
    `consult: verdict=${result.verdict} proceed=${result.proceed} band=${
      result.band
    } results=${parts.join(",")}`
  );
}

export function createHedwigServer(config: HedwigServerConfig): Server {
  const hasConsult = config.mode === "consult" || config.mode === "both";
  const hasEducation = config.mode === "education" || config.mode === "both";
  if (hasConsult && (!config.policyPath || !config.policyPin)) {
    throw new Error("consult mode requires a pinned policy file");
  }

  // Corpus loading and validation belong to the selected education profile.
  // A missing or invalid foundation pack must not disable consult or seed.
  let retrieveFoundations: FoundationRetriever | undefined;
  if (hasEducation && config.knowledgeMode === "foundations") {
    try {
      retrieveFoundations = require("./knowledge").retrieveFoundationSources;
    } catch (error) {
      // Education-only startup still rejects a broken pack. In both mode,
      // retain the independent pinned-policy tool and disable education.
      if (!hasConsult) throw error;
    }
  }

  const server = new Server(
    { name: "hedwig-mcp", version: "0.5.1" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...(hasConsult
        ? [
            {
              name: CONSULT_TOOL_NAME,
              description: CONSULT_TOOL_DESCRIPTION,
              inputSchema: {
                type: "object" as const,
                properties: { request: {} },
              },
            },
          ]
        : []),
      ...(hasEducation
        ? [
            {
              name: LEARNING_TOOL_NAME,
              description:
                config.knowledgeMode === "foundations"
                  ? FOUNDATIONS_TOOL_DESCRIPTION
                  : LEARNING_TOOL_DESCRIPTION,
              inputSchema: {
                type: "object" as const,
                properties: {
                  question: {
                    type: "string" as const,
                    maxLength: MAX_LEARNING_QUESTION_CHARS,
                  },
                  ...(config.knowledgeMode === "foundations"
                    ? {
                        mode: {
                          type: "string" as const,
                          enum: ["learn", "compare"],
                        },
                        deployments: {
                          type: "array" as const,
                          minItems: 2,
                          maxItems: 2,
                          items: {
                            type: "object" as const,
                            properties: {
                              chainId: { type: "integer" as const, minimum: 1 },
                              address: {
                                type: "string" as const,
                                pattern: "^0x[a-fA-F0-9]{40}$",
                              },
                            },
                            required: ["chainId", "address"],
                            additionalProperties: false,
                          },
                        },
                      }
                    : {}),
                },
                required: ["question"],
                additionalProperties: false,
              },
            },
          ]
        : []),
    ],
  }));

  const unavailableGenerator: GenerateAnswer = async () => {
    throw new Error("learning generator is not configured");
  };
  const generate = config.generate ?? unavailableGenerator;
  const generateFoundations: GenerateFoundationAnswer =
    config.generateFoundations ?? unavailableGenerator;

  server.fallbackRequestHandler = async (request, extra) => {
    if (request.method !== "tools/call") {
      throw new McpError(ErrorCode.MethodNotFound, "Method not found");
    }
    const { name, args } = readToolCall(request.params);

    if (name === CONSULT_TOOL_NAME && hasConsult) {
      let result: ConsultResponse;
      try {
        result = await handleConsult(
          args,
          config.policyPath!,
          config.policyPin!
        );
      } catch {
        result = unknownAdapterResponse(
          "ADAPTER_FAILED",
          "adapter failed to process the request"
        );
      }
      logVerdict(result);
      return toolResult(result as unknown as Record<string, unknown>);
    }

    if (name === LEARNING_TOOL_NAME && hasEducation) {
      if (config.knowledgeMode === "foundations" && !retrieveFoundations) {
        console.error("ask_hedwig: status=unavailable sources=0");
        return toolResult({ status: "unavailable" });
      }
      if (
        config.knowledgeMode !== "foundations" &&
        invalidLearningArguments(args)
      ) {
        const result = { status: "invalid_question" };
        console.error("ask_hedwig: status=invalid_question");
        return toolResult(result);
      }
      const result =
        config.knowledgeMode === "foundations"
          ? await answerExpertRequest(
              args,
              retrieveFoundations!,
              generateFoundations,
              extra.signal
            )
          : await answerLearningQuestion(
              (args as { question: string }).question,
              generate,
              extra.signal
            );
      const sourceCount =
        result.status === "answered" || result.status === "partial"
          ? result.sources.length
          : 0;
      console.error(
        `ask_hedwig: status=${result.status} sources=${sourceCount}`
      );
      return toolResult(result as unknown as Record<string, unknown>);
    }

    return {
      content: [{ type: "text" as const, text: "Tool not found" }],
      isError: true,
    };
  };

  return server;
}
