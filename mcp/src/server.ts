import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { handleConsult, unknownAdapterResponse } from "./handler";

const POLICY_PATH_ENV = "HEDWIG_POLICY_FILE";

// The path is never taken from, or influenced by, the tool call: it is read
// once, at start, from a required environment variable. A server started
// without it refuses to run rather than guessing.
function requirePolicyPath(): string {
  const path = process.env[POLICY_PATH_ENV];
  if (!path) {
    console.error(
      `${POLICY_PATH_ENV} must name the owner's policy file; refusing to start without it.`
    );
    process.exit(1);
  }
  return path;
}

function main(): void {
  const policyPath = requirePolicyPath();
  const server = new McpServer({ name: "hedwig-mcp", version: "0.1.0" });

  server.registerTool(
    "consult",
    {
      description:
        "Checks a payment request against the owner's policy and returns an advisory verdict of ALLOW_UNDER_POLICY, DENY, or UNKNOWN with the result of each check.",
      inputSchema: { request: z.unknown() },
    },
    async (args) => {
      // Defence in depth: handleConsult never throws by design, but a
      // thrown error must still never reach the caller as an MCP error.
      let result;
      try {
        result = handleConsult(args, policyPath);
      } catch {
        result = unknownAdapterResponse(
          "adapter failed to process the request"
        );
      }

      // Stderr only ever carries the verdict and each Condition's id and
      // status: never the request body, the policy content, the policy
      // path, or an evidence string.
      const summary = result.results
        .map((r) => `${r.id}:${r.status}`)
        .join(",");
      console.error(`consult: verdict=${result.verdict} results=${summary}`);

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
        isError: false,
      };
    }
  );

  const transport = new StdioServerTransport();
  server.connect(transport).catch((error: unknown) => {
    console.error("hedwig-mcp: failed to connect to stdio transport", error);
    process.exit(1);
  });
}

main();
