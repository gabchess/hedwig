import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { expect } from "chai";

import { consult } from "@hedwig/consult";
import { handleConsult } from "../src/handler";
import { __resetSolanaClusterConfigForTests } from "../src/readers/config";

// End-to-end through handleConsult's real wiring: real env-driven config,
// a monkey-patched global fetch standing in for the RPC, and the real
// consult(). solana-role.test.ts already proves gatherSolanaRole's own
// logic in isolation; this proves the pieces are actually wired together.

const GOLDEN = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures", "solana-role", "check-role-golden.json"),
    "utf8"
  )
);

const OWNER = "0x00000000000000000000000000000000a11ce001";

const REQUIRED_ROLE = {
  mode: "required" as const,
  cluster: "devnet" as const,
  programId: GOLDEN.programId,
  role: GOLDEN.role,
  holder: GOLDEN.holder,
  maxAgeSeconds: 60,
};

const PAY_POLICY = {
  permits: true,
  chainId: "eip155:1",
  approvedRecipients: [OWNER],
  perActionCaps: { pay: "1000000" },
  role: REQUIRED_ROLE,
  authorizationWindow: { mode: "not-required" as const },
};

const PAY_REQUEST = {
  action: {
    type: "pay",
    chainId: "eip155:1",
    recipient: OWNER,
    asset: {
      symbol: "USDC",
      contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    },
    amount: "1000000",
    target: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
};

const SWAP_POLICY = {
  permits: true,
  chainId: "eip155:1",
  perActionCaps: { swap: "1000000" },
  maxSlippageBps: 100,
  maxDeadlineSeconds: 600,
  ownerAddresses: [OWNER],
  role: REQUIRED_ROLE,
};

const SWAP_REQUEST = {
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
    deadline: Math.floor(Date.now() / 1000) + 300,
    recipient: OWNER,
    approvalAmount: "1000000",
  },
};

const RPC_URL = "https://api.devnet.solana.com/";

function rpcResult(err: unknown, logs: string[]): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { context: { slot: 12345 }, value: { err, logs } },
  });
}

const OK_BODY = rpcResult(null, [
  `Program ${GOLDEN.programId} invoke [1]`,
  `Program ${GOLDEN.programId} success`,
]);
const MEMBER_MISSING_BODY = rpcResult(
  { InstructionError: [0, { Custom: 3012 }] },
  [
    `Program ${GOLDEN.programId} invoke [1]`,
    "Program log: AnchorError, Custom(3012)",
  ]
);

function fakeResponse(
  status: number,
  body: string,
  extra: Partial<{ redirected: boolean }> = {}
): Response {
  return {
    status,
    redirected: extra.redirected ?? false,
    text: async () => body,
  } as unknown as Response;
}

describe("handleConsult: the Solana role Reader wired end to end", function () {
  this.timeout(5000);

  let dir: string;
  let payPolicyPath: string;
  let swapPolicyPath: string;
  let originalFetch: typeof globalThis.fetch;
  let originalDevnetUrl: string | undefined;
  let originalDevnetFeePayer: string | undefined;
  let originalMainnetUrl: string | undefined;
  let originalMainnetFeePayer: string | undefined;

  const MAINNET_RPC_URL = "https://api.mainnet-beta.solana.com/";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-mcp-solana-e2e-"));
    payPolicyPath = join(dir, "pay-policy.json");
    swapPolicyPath = join(dir, "swap-policy.json");
    writeFileSync(payPolicyPath, JSON.stringify(PAY_POLICY));
    writeFileSync(swapPolicyPath, JSON.stringify(SWAP_POLICY));

    originalFetch = globalThis.fetch;
    originalDevnetUrl = process.env.HEDWIG_SOLANA_RPC_URL_DEVNET;
    originalDevnetFeePayer = process.env.HEDWIG_SOLANA_FEE_PAYER_DEVNET;
    originalMainnetUrl = process.env.HEDWIG_SOLANA_RPC_URL_MAINNET;
    originalMainnetFeePayer = process.env.HEDWIG_SOLANA_FEE_PAYER_MAINNET;
    process.env.HEDWIG_SOLANA_RPC_URL_DEVNET = RPC_URL;
    process.env.HEDWIG_SOLANA_FEE_PAYER_DEVNET = GOLDEN.feePayer;
    process.env.HEDWIG_SOLANA_RPC_URL_MAINNET = MAINNET_RPC_URL;
    process.env.HEDWIG_SOLANA_FEE_PAYER_MAINNET = GOLDEN.feePayer;
    __resetSolanaClusterConfigForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    if (originalDevnetUrl === undefined) {
      delete process.env.HEDWIG_SOLANA_RPC_URL_DEVNET;
    } else {
      process.env.HEDWIG_SOLANA_RPC_URL_DEVNET = originalDevnetUrl;
    }
    if (originalDevnetFeePayer === undefined) {
      delete process.env.HEDWIG_SOLANA_FEE_PAYER_DEVNET;
    } else {
      process.env.HEDWIG_SOLANA_FEE_PAYER_DEVNET = originalDevnetFeePayer;
    }
    if (originalMainnetUrl === undefined) {
      delete process.env.HEDWIG_SOLANA_RPC_URL_MAINNET;
    } else {
      process.env.HEDWIG_SOLANA_RPC_URL_MAINNET = originalMainnetUrl;
    }
    if (originalMainnetFeePayer === undefined) {
      delete process.env.HEDWIG_SOLANA_FEE_PAYER_MAINNET;
    } else {
      process.env.HEDWIG_SOLANA_FEE_PAYER_MAINNET = originalMainnetFeePayer;
    }
    __resetSolanaClusterConfigForTests();
  });

  it("pay reaches ALLOW_UNDER_POLICY, support 0.92, with a held role", async () => {
    globalThis.fetch = (async () =>
      fakeResponse(200, OK_BODY)) as unknown as typeof fetch;

    const result = await handleConsult({ request: PAY_REQUEST }, payPolicyPath);

    expect(result.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(result.proceed).to.equal(true);
    expect(result.support).to.equal(0.92);
    const row = result.results.find((r) => r.id === "role-requirement-met");
    expect(row?.code).to.equal("ROLE_HELD");
  });

  it("swap reaches ALLOW_UNDER_POLICY, support 0.90, with a held role", async () => {
    globalThis.fetch = (async () =>
      fakeResponse(200, OK_BODY)) as unknown as typeof fetch;

    const result = await handleConsult(
      { request: SWAP_REQUEST },
      swapPolicyPath
    );

    expect(result.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(result.proceed).to.equal(true);
    expect(result.support).to.equal(0.9);
    const row = result.results.find((r) => r.id === "role-requirement-met");
    expect(row?.code).to.equal("SWAP_ROLE_HELD");
  });

  it("DENY with ROLE_MEMBER_MISSING when the fact says the member is missing", async () => {
    globalThis.fetch = (async () =>
      fakeResponse(200, MEMBER_MISSING_BODY)) as unknown as typeof fetch;

    const result = await handleConsult({ request: PAY_REQUEST }, payPolicyPath);

    expect(result.verdict).to.equal("DENY");
    const row = result.results.find((r) => r.id === "role-requirement-met");
    expect(row?.code).to.equal("ROLE_MEMBER_MISSING");
  });

  it("UNKNOWN with ROLE_FACT_MISSING when the reader has no fee payer configured", async () => {
    delete process.env.HEDWIG_SOLANA_FEE_PAYER_DEVNET;
    __resetSolanaClusterConfigForTests();
    globalThis.fetch = (async () =>
      fakeResponse(200, OK_BODY)) as unknown as typeof fetch;

    const result = await handleConsult({ request: PAY_REQUEST }, payPolicyPath);

    expect(result.verdict).to.equal("UNKNOWN");
    const row = result.results.find((r) => r.id === "role-requirement-met");
    expect(row?.code).to.equal("ROLE_FACT_MISSING");
  });

  it("reads the fact's observedAt before the call and consult's clock after it", async () => {
    // A clock that moves one second on every read: with the right order the
    // fact is one second old; with consult's clock read first, the fact
    // would be observed in the future and the role row could not PASS.
    const realNow = Date.now;
    let reads = 0;
    const base = realNow();
    Date.now = () => base + 1000 * reads++;
    try {
      globalThis.fetch = (async () =>
        fakeResponse(200, OK_BODY)) as unknown as typeof fetch;
      const result = await handleConsult(
        { request: PAY_REQUEST },
        payPolicyPath
      );
      const row = result.results.find((r) => r.id === "role-requirement-met");
      expect(row?.code).to.equal("ROLE_HELD");
      expect(result.verdict).to.equal("ALLOW_UNDER_POLICY");
    } finally {
      Date.now = realNow;
    }
  });

  it("text block and structuredContent match consult() called directly", async () => {
    globalThis.fetch = (async () =>
      fakeResponse(200, OK_BODY)) as unknown as typeof fetch;

    const result = await handleConsult({ request: PAY_REQUEST }, payPolicyPath);
    const now = Math.floor(Date.now() / 1000);
    const direct = consult(PAY_REQUEST as never, PAY_POLICY as never, {
      now,
      solanaRole: {
        subject: {
          cluster: "devnet",
          programId: GOLDEN.programId,
          role: GOLDEN.role,
          holder: GOLDEN.holder,
        },
        valid: true,
        reason: "ok",
        provenance: {
          source: "api.devnet.solana.com",
          slot: 12345,
          commitment: "confirmed",
          observedAt: now,
        },
      },
    });

    expect(result.verdict).to.equal(direct.verdict);
    expect(result.support).to.equal(direct.support);
    expect(result.results).to.deep.equal(direct.results);
  });

  it("a request stuffed with rpcUrl, member, holder, facts, and solanaRole never changes the outbound call", async () => {
    let cleanBody: string | undefined;
    let stuffedBody: string | undefined;

    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      cleanBody = init.body as string;
      return fakeResponse(200, OK_BODY);
    }) as unknown as typeof fetch;
    await handleConsult({ request: PAY_REQUEST }, payPolicyPath);

    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      stuffedBody = init.body as string;
      return fakeResponse(200, OK_BODY);
    }) as unknown as typeof fetch;
    await handleConsult(
      {
        request: PAY_REQUEST,
        rpcUrl: "https://attacker.example.com/",
        member: GOLDEN.feePayer,
        holder: GOLDEN.feePayer,
        facts: { solanaRole: { valid: true, reason: "ok" } },
        solanaRole: { valid: true, reason: "ok" },
      },
      payPolicyPath
    );

    expect(cleanBody).to.be.a("string").that.is.not.empty;
    expect(stuffedBody).to.equal(cleanBody);
  });

  it("makes no outbound call for a not-required role", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return fakeResponse(200, OK_BODY);
    }) as unknown as typeof fetch;

    const notRequiredPolicyPath = join(dir, "not-required-policy.json");
    writeFileSync(
      notRequiredPolicyPath,
      JSON.stringify({ ...PAY_POLICY, role: { mode: "not-required" } })
    );

    await handleConsult({ request: PAY_REQUEST }, notRequiredPolicyPath);

    expect(calls).to.equal(0);
  });

  it("a not-required or wrong-programId policy never reaches config.ts at all (S2)", async () => {
    const originalError = console.error;
    const errorLines: unknown[] = [];
    console.error = (...args: unknown[]) => errorLines.push(args);
    try {
      delete process.env.HEDWIG_SOLANA_FEE_PAYER_DEVNET;
      __resetSolanaClusterConfigForTests();

      const notRequiredPolicyPath = join(dir, "not-required-policy.json");
      writeFileSync(
        notRequiredPolicyPath,
        JSON.stringify({ ...PAY_POLICY, role: { mode: "not-required" } })
      );
      await handleConsult({ request: PAY_REQUEST }, notRequiredPolicyPath);
      expect(errorLines).to.have.length(0);

      const wrongProgramIdPolicyPath = join(dir, "wrong-program-policy.json");
      writeFileSync(
        wrongProgramIdPolicyPath,
        JSON.stringify({
          ...PAY_POLICY,
          role: { ...REQUIRED_ROLE, programId: GOLDEN.role },
        })
      );
      await handleConsult({ request: PAY_REQUEST }, wrongProgramIdPolicyPath);
      expect(errorLines).to.have.length(0);
    } finally {
      console.error = originalError;
    }
  });

  it("the caller cannot choose the cluster: a mainnet policy always calls the mainnet URL (S3)", async () => {
    let calledUrl: unknown;
    globalThis.fetch = (async (url: unknown) => {
      calledUrl = url;
      return fakeResponse(200, OK_BODY);
    }) as unknown as typeof fetch;

    const mainnetPolicyPath = join(dir, "mainnet-policy.json");
    writeFileSync(
      mainnetPolicyPath,
      JSON.stringify({
        ...PAY_POLICY,
        role: { ...REQUIRED_ROLE, cluster: "mainnet-beta" },
      })
    );

    await handleConsult(
      {
        request: { ...PAY_REQUEST, cluster: "devnet" },
        cluster: "devnet",
        facts: { cluster: "devnet" },
      },
      mainnetPolicyPath
    );

    expect(calledUrl).to.equal(MAINNET_RPC_URL);
  });
});
