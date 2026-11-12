import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect } from "chai";

const SERVER_PATH = join(process.cwd(), "mcp", "dist", "server.js");
const CLIENT_SCRIPT = join(
  process.cwd(),
  "mcp",
  "test",
  "education-e2e-client.js"
);

function cleanEnvironment(overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env, ...overrides };
  delete env.HEDWIG_POLICY_FILE;
  delete env.OPENROUTER_API_KEY;
  delete env.HEDWIG_OPENROUTER_MODEL;
  return env;
}

describe("education mode over real MCP stdio", function () {
  this.timeout(15000);

  before(() => {
    expect(existsSync(SERVER_PATH), "run mcp:build first").to.equal(true);
  });

  it("starts without a policy or model configuration and fails closed on missing inference", () => {
    const result = spawnSync(process.execPath, [CLIENT_SCRIPT, SERVER_PATH], {
      encoding: "utf8",
      env: cleanEnvironment(),
      timeout: 10000,
    });
    expect(result.status).to.equal(0, result.stderr);
    const output = JSON.parse(result.stdout);
    expect(
      output.tools.map((tool: { name: string }) => tool.name)
    ).to.deep.equal(["ask_hedwig"]);
    expect(output.supported.structuredContent.status).to.equal("unavailable");
    expect(output.supported.structuredContent.answer).to.equal(undefined);
    expect(output.unsupported.structuredContent.status).to.equal(
      "insufficient_evidence"
    );
    expect(output.extra.structuredContent.status).to.equal("invalid_question");
    expect(output.stderr).to.not.include("CANARY-EXTRA-ARGUMENT");
  });

  it("refuses unknown mode and combined mode without the policy path", () => {
    const unknown = spawnSync(process.execPath, [SERVER_PATH], {
      encoding: "utf8",
      env: cleanEnvironment({ HEDWIG_MODE: "unknown" }),
      timeout: 5000,
    });
    expect(unknown.status).to.not.equal(0);
    expect(unknown.stderr).to.include("HEDWIG_MODE");

    const combined = spawnSync(process.execPath, [SERVER_PATH], {
      encoding: "utf8",
      env: cleanEnvironment({ HEDWIG_MODE: "both" }),
      timeout: 5000,
    });
    expect(combined.status).to.not.equal(0);
    expect(combined.stderr).to.include("HEDWIG_POLICY_FILE");
  });
});
