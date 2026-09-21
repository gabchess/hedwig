import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import type { ConsultResponse } from "@hedwig/consult";

import { handleConsult, unknownAdapterResponse } from "./handler";

const POLICY_PATH_ENV = "HEDWIG_POLICY_FILE";
const TOOL_NAME = "consult";
const TOOL_DESCRIPTION =
  "Checks a payment or swap request against the owner's policy and returns whether to proceed, with a verdict, a support score from 0 to 1, a band, and the result of each check. Act on proceed only.";

// Bounds one incoming message before the transport finishes buffering it
// into a JSON-RPC line, so a message far larger than any real call never
// gets fully read into memory. This is separate from, and larger than, the
// 64 KB argument cap in handler.ts, which bounds one field of a message
// this cap has already let through.
const MAX_TRANSPORT_BYTES = 256 * 1024;

// The path is never taken from, or influenced by, the tool call: it is read
// once, at start, from a required environment variable. A server started
// without it, or with only whitespace in it, refuses to run rather than
// guessing.
function requirePolicyPath(): string {
  const path = process.env[POLICY_PATH_ENV]?.trim();
  if (!path) {
    console.error(
      `${POLICY_PATH_ENV} must name the owner's policy file; refusing to start without it.`
    );
    process.exit(1);
  }
  return path;
}

// The SDK validates every registered "tools/call" against its own fixed
// schema before tool code runs, which turns a missing or non-object
// `arguments` into a JSON-RPC error. No tools/call handler is registered, so
// those calls reach the SDK's fallback handler below, and handleConsult is
// what decides what a bad shape means.
function readToolCall(params: unknown): { name: unknown; args: unknown } {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return { name: undefined, args: undefined };
  }
  const record = params as Record<string, unknown>;
  return { name: record.name, args: record.arguments };
}

// Only ids consult() itself names as floorIds are ever printed on stderr,
// each with its status. A caller can name arbitrary ids of its own in
// request.conditions, and those become part of the same results array, so
// counting them instead of printing them keeps a caller-chosen string out
// of the log stream. proceed and band are fixed-vocabulary fields consult()
// itself computes, never a caller string and never evidence, so they are
// safe to print alongside the verdict.
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

function main(): void {
  const policyPath = requirePolicyPath();
  const server = new Server(
    { name: "hedwig-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        inputSchema: { type: "object" as const, properties: { request: {} } },
      },
    ],
  }));

  server.fallbackRequestHandler = async (request) => {
    if (request.method !== "tools/call") {
      throw new McpError(ErrorCode.MethodNotFound, "Method not found");
    }
    const { name, args } = readToolCall(request.params);
    if (name !== TOOL_NAME) {
      return {
        content: [{ type: "text" as const, text: "Tool not found" }],
        isError: true,
      };
    }

    // handleConsult catches its own errors; this catch keeps a bug in it
    // from becoming anything other than an UNKNOWN answer.
    let result: ConsultResponse;
    try {
      result = handleConsult(args, policyPath);
    } catch {
      result = unknownAdapterResponse(
        "ADAPTER_FAILED",
        "adapter failed to process the request"
      );
    }

    logVerdict(result);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result as unknown as Record<string, unknown>,
      isError: false,
    };
  };

  const transport = new StdioServerTransport(undefined, undefined, {
    maxBufferSize: MAX_TRANSPORT_BYTES,
  });
  // A line that is not valid JSON-RPC is the caller's problem, not a reason
  // to stop serving, and its error message quotes the caller's bytes, so
  // nothing from it is logged. A message over MAX_TRANSPORT_BYTES is
  // different: the SDK closes the transport, no request is left to answer,
  // and exiting non-zero lets a supervisor see it.
  let overflowed = false;
  transport.onerror = (error: Error) => {
    if (error.message.startsWith("ReadBuffer exceeded maximum size")) {
      overflowed = true;
      console.error("hedwig-mcp: input exceeded the transport limit");
    }
  };
  transport.onclose = () => {
    process.exit(overflowed ? 1 : 0);
  };
  server.connect(transport).catch(() => {
    console.error("hedwig-mcp: failed to connect to stdio transport");
    process.exit(1);
  });
}

main();
