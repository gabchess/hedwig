export type GenerationPurpose = "seed" | "foundations";

type GenerationPolicy = {
  readonly deadlineMs: number;
  readonly maxTokens: Readonly<Record<GenerationPurpose, number>>;
  readonly providerParameters?: { readonly sort: "throughput" };
  readonly requestParameters:
    | { readonly temperature: 0 }
    | {
        readonly reasoning: {
          readonly effort: "low" | "medium" | "high";
          readonly exclude: true;
        };
      };
};

const STANDARD_DEADLINE_MS = 15_000;
const REASONING_DEADLINE_MS = 20_000;
const SEED_MAX_TOKENS = 1024;
const FOUNDATION_MAX_TOKENS = 2048;
const REASONING_MAX_TOKENS = 4096;
const REASONING_MODEL = "openai/gpt-5.1";
const EXTENDED_REASONING_MODEL = "openai/gpt-5.2";
const EXTENDED_REASONING_DEADLINE_MS = 30_000;
const EXTENDED_REASONING_MAX_TOKENS = 6144;
const QWEN_INSTRUCT_MODEL = "qwen/qwen3-235b-a22b-2507";
const QWEN_INSTRUCT_DEADLINE_MS = 45_000;
const DEEPSEEK_REASONING_MODEL = "deepseek/deepseek-v4-flash-0731";
const DEEPSEEK_REASONING_DEADLINE_MS = 90_000;
const DEEPSEEK_REASONING_MAX_TOKENS = 8192;
const STANDARD_TOOL_CALL_TIMEOUT_MS = 60_000;
const EXTENDED_TOOL_COMPLETION_MARGIN_MS = 30_000;

/** Only the operator-selected model determines the generation policy. */
export function resolveModelGenerationPolicy(model: string): GenerationPolicy {
  if (model === DEEPSEEK_REASONING_MODEL) {
    return {
      deadlineMs: DEEPSEEK_REASONING_DEADLINE_MS,
      maxTokens: {
        seed: DEEPSEEK_REASONING_MAX_TOKENS,
        foundations: DEEPSEEK_REASONING_MAX_TOKENS,
      },
      requestParameters: { reasoning: { effort: "high", exclude: true } },
    };
  }
  if (model === EXTENDED_REASONING_MODEL) {
    return {
      deadlineMs: EXTENDED_REASONING_DEADLINE_MS,
      maxTokens: {
        seed: EXTENDED_REASONING_MAX_TOKENS,
        foundations: EXTENDED_REASONING_MAX_TOKENS,
      },
      requestParameters: { reasoning: { effort: "medium", exclude: true } },
    };
  }
  if (model === REASONING_MODEL) {
    return {
      deadlineMs: REASONING_DEADLINE_MS,
      maxTokens: {
        seed: REASONING_MAX_TOKENS,
        foundations: REASONING_MAX_TOKENS,
      },
      // Reasoning and the visible answer share max_tokens. Temperature is not
      // supported with reasoning enabled; exclude keeps reasoning out of output.
      requestParameters: { reasoning: { effort: "low", exclude: true } },
    };
  }
  return {
    deadlineMs:
      model === QWEN_INSTRUCT_MODEL
        ? QWEN_INSTRUCT_DEADLINE_MS
        : STANDARD_DEADLINE_MS,
    maxTokens: { seed: SEED_MAX_TOKENS, foundations: FOUNDATION_MAX_TOKENS },
    requestParameters: { temperature: 0 },
    // Sorting changes preference only; privacy, price and fallback constraints
    // remain enforced by the adapter and evaluation guard.
    ...(model === QWEN_INSTRUCT_MODEL
      ? { providerParameters: { sort: "throughput" as const } }
      : {}),
  };
}

/** Preserve the existing SDK timeout unless generation needs a longer window. */
export function resolveToolCallTimeoutMs(model: string): number {
  const { deadlineMs } = resolveModelGenerationPolicy(model);
  return deadlineMs > STANDARD_TOOL_CALL_TIMEOUT_MS
    ? deadlineMs + EXTENDED_TOOL_COMPLETION_MARGIN_MS
    : STANDARD_TOOL_CALL_TIMEOUT_MS;
}
