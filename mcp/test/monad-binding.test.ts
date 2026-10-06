import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { handleConsult } from "../src/handler";
import fixture from "../../consult/test/fixtures/monad-router02.json";

const router = "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900";
const owner = fixture.expected.recipient;
function request() {
  return {
    action: {
      type: "swap",
      chainId: "eip155:143",
      target: router,
      tokenIn: { kind: "native", symbol: "MON" },
      tokenOut: {
        symbol: "USDC",
        contractAddress: fixture.expected.outputAddress,
      },
      amountIn: "10000000000000000000",
      quotedOut: "10000000",
      minOut: "9950000",
      slippageBps: 50,
      deadline: 1791320400,
      recipient: owner,
      approvalAmount: "0",
    },
    transaction: {
      from: owner,
      to: router,
      data: fixture.data,
      value: "10000000000000000000",
    },
  };
}

describe("native Monad handler binding (offline)", () => {
  let dir: string;
  let policyPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-monad-binding-"));
    policyPath = join(dir, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        permits: false,
        chainId: "eip155:143",
        approvedRecipients: [owner],
        perActionCaps: { swap: "10000000000000000000" },
        ownerAddresses: [owner],
        role: { mode: "not-required" },
      })
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("captures call bytes and intent before asynchronous evidence collection", async () => {
    const input = request();
    const response = handleConsult({ request: input }, policyPath);
    input.transaction.value = "1";
    const result = await response;
    expect(
      result.results.find((row) => row.id === "target-is-canonical")?.code
    ).to.equal("SWAP_TARGET_ROUTER_UNKNOWN");
    expect(result.proceed).to.equal(false);
  });
});
