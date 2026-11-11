import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createOpenRouterGenerator } from "./openrouter";
import { createHedwigServer, resolveHedwigMode } from "./server-core";
import { pinPolicyFile } from "./policy";

const POLICY_PATH_ENV = "HEDWIG_POLICY_FILE";
const OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";
const OPENROUTER_MODEL_ENV = "HEDWIG_OPENROUTER_MODEL";

// Bounds one incoming message before the transport finishes buffering it
// into a JSON-RPC line, so a message far larger than any real call never
// gets fully read into memory. This is separate from, and larger than, the
// 64 KB argument cap in handler.ts, which bounds one field of a message
// this cap has already let through.
const MAX_TRANSPORT_BYTES = 256 * 1024;

function requirePolicyPath(): string | undefined {
  const path = process.env[POLICY_PATH_ENV]?.trim();
  if (!path) {
    console.error(
      `${POLICY_PATH_ENV} must name the owner's policy file; refusing to start without it.`
    );
  }
  return path;
}

function configuredGenerator(mode: "consult" | "education" | "both") {
  if (mode === "consult") return undefined;
  const apiKey = process.env[OPENROUTER_KEY_ENV]?.trim();
  const model = process.env[OPENROUTER_MODEL_ENV]?.trim();
  if (!apiKey || !model) return undefined;
  try {
    return createOpenRouterGenerator({ apiKey, model });
  } catch {
    console.error("hedwig-mcp: learning model configuration is invalid");
    return undefined;
  }
}

function main(): void {
  let mode: "consult" | "education" | "both";
  try {
    mode = resolveHedwigMode(process.env.HEDWIG_MODE);
  } catch {
    console.error(
      "HEDWIG_MODE must be consult, education, or both; refusing to start."
    );
    process.exit(1);
    return;
  }

  const consultEnabled = mode === "consult" || mode === "both";
  let policyPath: string | undefined;
  let policyPin: ReturnType<typeof pinPolicyFile> | undefined;
  if (consultEnabled) {
    policyPath = requirePolicyPath();
    if (!policyPath) {
      process.exit(1);
      return;
    }
    // The policy's bytes are hashed once, here. Every later call in this run
    // must read the same bytes, so an agent that can write the file cannot
    // change what this process enforces.
    policyPin = pinPolicyFile(policyPath);
  }

  const server = createHedwigServer({
    mode,
    ...(policyPath ? { policyPath, policyPin } : {}),
    ...(mode !== "consult" ? { generate: configuredGenerator(mode) } : {}),
  });

  const transport = new StdioServerTransport(undefined, undefined, {
    maxBufferSize: MAX_TRANSPORT_BYTES,
  });
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
