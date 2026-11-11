import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import type { ConsultResponse } from "@hedwig/consult";

import {
  answerLearningQuestion,
  MAX_LEARNING_QUESTION_CHARS,
  type GenerateAnswer,
} from "./expert";
import { handleConsult, unknownAdapterResponse } from "./handler";
import type { PolicyPin } from "./policy";

const CONSULT_TOOL_NAME = "consult";
const LEARNING_TOOL_NAME = "ask_hedwig";
const CONSULT_TOOL_DESCRIPTION =
  "Hedwig is the eval gate your payment agent checks before it transacts. The local checker evaluates payment and swap proposals against the owner's policy and returns a verdict, a 0-to-1 support score for evidence coverage (not safety probability), and each check's result and reason. It does not sign or submit transactions; the caller controls execution and should act only on 'proceed'.";
const LEARNING_TOOL_DESCRIPTION =
  "Ask Hedwig about a small set of reviewed learning topics. Answers use the supplied references. This seed prototype does not provide broad educational coverage or verify current conditions.";

export type HedwigMode = "consult" | "education" | "both";

export type HedwigServerConfig = {
  mode: HedwigMode;
  policyPath?: string;
  policyPin?: PolicyPin;
  generate?: GenerateAnswer;
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
              description: LEARNING_TOOL_DESCRIPTION,
              inputSchema: {
                type: "object" as const,
                properties: {
                  question: {
                    type: "string" as const,
                    maxLength: MAX_LEARNING_QUESTION_CHARS,
                  },
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

  server.fallbackRequestHandler = async (request) => {
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
      if (invalidLearningArguments(args)) {
        const result = { status: "invalid_question" };
        console.error("ask_hedwig: status=invalid_question");
        return toolResult(result);
      }
      const question = (args as { question: string }).question;
      const result = await answerLearningQuestion(question, generate);
      const sourceCount =
        result.status === "answered" ? result.sources.length : 0;
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
