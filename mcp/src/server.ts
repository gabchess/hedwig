import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Protocol } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ConsultResponse } from "@hedwig/consult";

import { handleConsult, unknownAdapterResponse } from "./handler";

const POLICY_PATH_ENV = "HEDWIG_POLICY_FILE";
const TOOL_NAME = "consult";
const TOOL_DESCRIPTION =
  "Checks a payment request against the owner's policy and returns an advisory verdict of ALLOW_UNDER_POLICY, DENY, or UNKNOWN with the result of each check.";

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

// The MCP SDK's own tools/call handling requires `arguments` to already be
// an object before any tool-specific code runs: Server.setRequestHandler
// re-validates every "tools/call" request against its own fixed schema, no
// matter what schema is registered for that method, so a looser schema
// registered the ordinary way still cannot let a non-object `arguments`
// through to handleConsult. Registering directly on Protocol, the class
// Server extends, carries no such re-validation, so that is the level at
// which a non-object, or missing, `arguments` can reach handleConsult
// instead of becoming a JSON-RPC error. handleConsult is what decides what
// a bad shape means, not this schema.
const AnyArgumentsToolCallSchema = z.object({
  method: z.literal("tools/call"),
  params: z.object({
    name: z.string(),
    arguments: z.unknown().optional(),
  }),
});

// Only ids consult() itself names as floorIds are ever printed on stderr,
// each with its status. A caller can name arbitrary ids of its own in
// request.conditions, and those become part of the same results array, so
// counting them instead of printing them keeps a caller-chosen string out
// of the log stream.
function logVerdict(result: ConsultResponse): void {
  const floorIds = new Set(result.floorIds);
  const named = result.results.filter((entry) => floorIds.has(entry.id));
  const parts = named.map((entry) => `${entry.id}:${entry.status}`);
  const extraCount = result.results.length - named.length;
  if (extraCount > 0) {
    parts.push(`extra:${extraCount}`);
  }
  console.error(
    `consult: verdict=${result.verdict} results=${parts.join(",")}`
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

  // Bypasses Server's built-in tools/call re-validation; see the schema's
  // own comment above for why that bypass is necessary here.
  Protocol.prototype.setRequestHandler.call(
    server,
    AnyArgumentsToolCallSchema,
    async (request: z.infer<typeof AnyArgumentsToolCallSchema>) => {
      if (request.params.name !== TOOL_NAME) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Tool ${request.params.name} not found`,
            },
          ],
          isError: true,
        };
      }

      // handleConsult already catches its own errors; this catch exists for
      // the case that assumption turns out to be wrong, so a bug in
      // handleConsult still answers UNKNOWN instead of throwing back
      // through the tools/call handler.
      let result: ConsultResponse;
      try {
        result = handleConsult(request.params.arguments, policyPath);
      } catch {
        result = unknownAdapterResponse(
          "adapter failed to process the request"
        );
      }

      logVerdict(result);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
        isError: false,
      };
    }
  );

  const transport = new StdioServerTransport(undefined, undefined, {
    maxBufferSize: MAX_TRANSPORT_BYTES,
  });
  // A message over MAX_TRANSPORT_BYTES, or any other transport-level
  // failure, closes the connection below us; there is no request left to
  // answer UNKNOWN on, so the only honest response is to exit non-zero and
  // let a supervisor see it.
  transport.onerror = (error: Error) => {
    console.error("hedwig-mcp: stdio transport failed:", error.message);
    process.exit(1);
  };
  server.connect(transport).catch((error: unknown) => {
    console.error("hedwig-mcp: failed to connect to stdio transport", error);
    process.exit(1);
  });
}

main();
