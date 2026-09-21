import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";

import { handleConsult } from "../src/handler";

const OWNER = "0x00000000000000000000000000000000a11ce001";
const POLICY = {
  permits: true,
  chainId: "eip155:1",
  perActionCaps: { swap: "1000000" },
  maxSlippageBps: 100,
  maxDeadlineSeconds: 600,
  ownerAddresses: [OWNER],
  role: { mode: "not-required" },
};

function swapRequest(deadline: number): Record<string, unknown> {
  return {
    action: {
      type: "swap",
      chainId: "eip155:1",
      target: "0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85",
      tokenIn: {
        symbol: "USDC",
        contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      },
      tokenOut: {
        symbol: "WETH",
        contractAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      },
      amountIn: "1000000",
      quotedOut: "1000000",
      minOut: "995000",
      slippageBps: 50,
      deadline,
      recipient: OWNER,
      approvalAmount: "1000000",
    },
  };
}

describe("handleConsult: swap", () => {
  let dir: string;
  let policyPath: string;
  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-mcp-swap-"));
    policyPath = join(dir, "policy.json");
    writeFileSync(policyPath, JSON.stringify(POLICY));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("supplies the time itself, in seconds: a clean swap proceeds", () => {
    const response = handleConsult(
      { request: swapRequest(nowSeconds() + 300) },
      policyPath
    );
    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(response.proceed).to.equal(true);
  });

  it("ignores a time the caller supplies, wherever the caller puts it", () => {
    const past = nowSeconds() - 3600;
    const callerFacts = { now: past - 60 };
    const request = { ...swapRequest(past), facts: callerFacts };
    const response = handleConsult(
      { request, facts: callerFacts, _meta: { facts: callerFacts } },
      policyPath
    );
    const row = response.results.find(
      (result) => result.id === "deadline-set-and-fresh"
    );
    expect(row?.code).to.equal("DEADLINE_PAST");
    expect(response.proceed).to.equal(false);
  });
});
