import { existsSync } from "node:fs";
import { join } from "node:path";

// Shared by every test that drives the built server as a child process:
// the same binary, the same "did you forget to build it" guard, and the
// same policy fixture wherever a whole valid policy file is needed.
export const MCP_ROOT = join(__dirname, "..");
export const SERVER_PATH = join(MCP_ROOT, "dist", "server.js");

export function assertServerBuilt(): void {
  if (!existsSync(SERVER_PATH)) {
    throw new Error(
      `${SERVER_PATH} is missing; run "yarn mcp:build" before "yarn mcp:test"`
    );
  }
}

export const VALID_POLICY = {
  permits: true,
  chainId: "eip155:1",
  approvedRecipients: ["0x00000000000000000000000000000000a11ce001"],
  perActionCaps: { pay: "1000000" },
};
