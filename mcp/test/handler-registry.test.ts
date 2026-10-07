import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";

import {
  __setRegistryDeadlineForTests,
  __setRegistryKeysForTests,
  handleConsult,
} from "../src/handler";
import {
  __resetRegistryConfigForTests,
  __resetSolanaClusterConfigForTests,
} from "../src/readers/config";
import {
  BASE,
  MONAD_USDC,
  RPC_URL,
  makeKeys,
  makeWorld,
  monadChain,
  monadUsdcRow,
  signed,
} from "./registry-helpers";
import type { World } from "./registry-helpers";
import swapFixture from "../../consult/test/fixtures/monad-router02.json";

// Through handleConsult's real wiring: real env-driven config, a patched
// global fetch standing in for the registry host, the RPC and (in one test)
// the Solana RPC, and the real consult().

const GOLDEN = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures", "solana-role", "check-role-golden.json"),
    "utf8"
  )
);

const OWNER = "0x00000000000000000000000000000000a11ce001";
const SOLANA_URL = "https://api.devnet.solana.com/";
const MONAD_PATH = "v1/eip155-143/USDC.json";

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";

const PAY_MONAD = {
  action: {
    type: "pay",
    chainId: "eip155:143",
    recipient: OWNER,
    asset: { symbol: "USDC", contractAddress: MONAD_USDC },
    amount: "1000000",
    target: MONAD_USDC,
  },
};

const POLICY = {
  permits: true,
  chainId: "eip155:143",
  approvedRecipients: [OWNER],
  perActionCaps: { pay: "1000000" },
  perActionCapAssets: { pay: MONAD_USDC },
  role: { mode: "not-required" },
  authorizationWindow: { mode: "not-required" },
};

const ENV_NAMES = [
  "HEDWIG_REGISTRY_URL",
  "HEDWIG_REGISTRY_RATCHET_FILE",
  "HEDWIG_EVM_RPC_URL_143",
  "HEDWIG_SOLANA_RPC_URL_DEVNET",
  "HEDWIG_SOLANA_FEE_PAYER_DEVNET",
] as const;

describe("handleConsult: the registry Reader wired end to end", function () {
  this.timeout(10000);

  const keys = makeKeys();
  let dir: string;
  let policyPath: string;
  let world: World;
  let originalFetch: typeof globalThis.fetch;
  const originalEnv: Record<string, string | undefined> = {};

  const logged = () => world.log.map((entry) => entry.url);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-mcp-registry-e2e-"));
    policyPath = join(dir, "policy.json");
    writeFileSync(policyPath, JSON.stringify(POLICY));
    // Rows that stay valid whenever this runs: an hour old, good for 30 days.
    const verifiedAt = iso(Date.now() - 3600 * 1000);
    const expiresAt = iso(Date.now() + 30 * 86400 * 1000);
    world = makeWorld(
      {
        [MONAD_PATH]: signed(monadUsdcRow({ verifiedAt, expiresAt }), keys),
      },
      monadChain()
    );
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) =>
      world.fetch(input as string, init)) as typeof fetch;
    for (const name of ENV_NAMES) {
      originalEnv[name] = process.env[name];
      delete process.env[name];
    }
    process.env.HEDWIG_REGISTRY_URL = BASE;
    process.env.HEDWIG_REGISTRY_RATCHET_FILE = join(dir, "ratchet.json");
    process.env.HEDWIG_EVM_RPC_URL_143 = RPC_URL;
    __resetRegistryConfigForTests();
    __resetSolanaClusterConfigForTests();
    __setRegistryKeysForTests(keys.pub);
    __setRegistryDeadlineForTests(5000);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    for (const name of ENV_NAMES) {
      if (originalEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalEnv[name];
      }
    }
    __resetRegistryConfigForTests();
    __resetSolanaClusterConfigForTests();
    __setRegistryKeysForTests(undefined);
    __setRegistryDeadlineForTests(undefined);
  });

  const row = (
    result: { results: ReadonlyArray<{ id: string }> },
    id: string
  ) =>
    result.results.find((r) => r.id === id) as
      | { id: string; status: string; code: string }
      | undefined;

  it("a signed Monad USDC row and a confirmed live read make the asset and the target canonical", async () => {
    const result = await handleConsult({ request: PAY_MONAD }, policyPath);

    expect(row(result, "asset-is-canonical")?.status).to.equal("PASS");
    expect(row(result, "target-is-canonical")?.status).to.equal("PASS");
    expect(result.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(logged()).to.include(`${BASE}/${MONAD_PATH}`);
    expect(logged()).to.include(RPC_URL);
  });

  it("a live code-hash mismatch is not a pass", async () => {
    world.chain.code[MONAD_USDC] = "0x00";
    const result = await handleConsult({ request: PAY_MONAD }, policyPath);

    expect(row(result, "asset-is-canonical")?.status).to.not.equal("PASS");
    expect(result.proceed).to.equal(false);
  });

  const nativeSwap = (address = MONAD_USDC) => ({
    action: {
      type: "swap",
      chainId: "eip155:143",
      recipient: OWNER,
      target: MONAD_USDC,
      tokenIn: { kind: "native", symbol: "MON" },
      tokenOut: { symbol: "USDC", contractAddress: address },
      amountIn: "10000000000000000000",
      quotedOut: "1000000",
      minOut: "995000",
      slippageBps: 50,
      deadline: Math.floor(Date.now() / 1000) + 300,
      approvalAmount: "0",
    },
  });
  // Bind the declared intent to the synthetic, offline Router02 fixture.
  const boundNativeSwap = (address = MONAD_USDC) => {
    const router = "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900";
    return {
      action: {
        ...nativeSwap(address).action,
        target: router,
        recipient: swapFixture.expected.recipient,
        quotedOut: "10000000",
        minOut: "9950000",
        deadline: 1791320400,
      },
      transaction: {
        from: swapFixture.expected.recipient,
        to: router,
        value: "10000000000000000000",
        data:
          swapFixture.data.slice(0, 490) +
          address.slice(2) +
          swapFixture.data.slice(530),
      },
    };
  };
  const withIssuer = () => {
    const retrievedAt = iso(Date.now() - 3600 * 1000);
    world.files[MONAD_PATH] = signed(
      monadUsdcRow({
        verifiedAt: retrievedAt,
        expiresAt: iso(Date.now() + 30 * 86400 * 1000),
        patch: {
          evidence: [
            {
              origin: "circle.com",
              url: "https://developers.circle.com/stablecoins/usdc-contract-addresses",
              retrievedAt,
            },
          ],
        },
      }),
      keys
    );
  };

  it("native MON to an incorrect USDC output returns a sourced denial through the handler", async () => {
    withIssuer();
    const result = await handleConsult(
      { request: boundNativeSwap("0x" + "7".repeat(40)) },
      policyPath
    );
    expect(row(result, "target-is-canonical")?.code).to.equal(
      "SWAP_TARGET_ROUTER_UNKNOWN"
    );
    expect(row(result, "token-out-is-canonical")?.code).to.equal(
      "SWAP_TOKEN_OUT_NOT_CANONICAL"
    );
    expect(row(result, "token-out-is-canonical"))
      .to.have.property("canonicalAsset")
      .that.includes({
        chainId: "eip155:143",
        symbol: "USDC",
        contractAddress: MONAD_USDC,
      });
    expect(result.verdict).to.equal("DENY");
    expect(result.support).to.equal(0);
    expect(result.proceed).to.equal(false);
    expect(JSON.stringify(result)).to.not.include(RPC_URL);
    expect(logged()).to.include(`${BASE}/${MONAD_PATH}`);
    expect(logged()).to.include(RPC_URL);
  });

  it("native MON to a matching USDC output proves identity and keeps execution blocked", async () => {
    withIssuer();
    const result = await handleConsult(
      { request: boundNativeSwap() },
      policyPath
    );
    expect(row(result, "target-is-canonical")?.code).to.equal(
      "SWAP_TARGET_ROUTER_UNKNOWN"
    );
    expect(row(result, "token-out-is-canonical")?.status).to.equal("PASS");
    expect(result.proceed).to.equal(false);
    expect(result.support).to.equal(0);
    expect(logged()).to.include(`${BASE}/${MONAD_PATH}`);
    expect(logged()).to.include(RPC_URL);
  });

  it("a complete call with a fake output retains the sourced denial", async () => {
    withIssuer();
    const fake = "77".repeat(20);
    const input = nativeSwap(`0x${fake}`);
    input.action.target = "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900";
    input.action.recipient = swapFixture.expected.recipient;
    input.action.minOut = "9950000";
    input.action.quotedOut = "10000000";
    input.action.deadline = 1791320400;
    const result = await handleConsult(
      {
        request: {
          ...input,
          transaction: {
            from: swapFixture.expected.recipient,
            to: input.action.target,
            value: "10000000000000000000",
            data:
              swapFixture.data.slice(0, 490) +
              fake +
              swapFixture.data.slice(530),
          },
        },
      },
      policyPath
    );
    expect(row(result, "target-is-canonical")?.code).to.equal(
      "SWAP_TARGET_ROUTER_UNKNOWN"
    );
    expect(row(result, "token-out-is-canonical"))
      .to.have.property("canonicalAsset")
      .that.includes({ contractAddress: MONAD_USDC });
    expect(result.verdict).to.equal("DENY");
    expect(result.support).to.equal(0);
    expect(result.proceed).to.equal(false);
  });

  it("an intent-only native swap refuses before any evidence read", async () => {
    withIssuer();
    const result = await handleConsult({ request: nativeSwap() }, policyPath);
    expect(logged()).to.deep.equal([]);
    expect(row(result, "target-is-canonical")?.code).to.equal(
      "MONAD_CALL_UNSUPPORTED"
    );
    expect(row(result, "token-out-is-canonical")?.status).to.equal(
      "UNVERIFIED"
    );
    expect(row(result, "token-out-is-canonical")).to.not.have.property(
      "canonicalAsset"
    );
    expect(result.proceed).to.equal(false);
  });

  it("a hanging registry read aborts and answers UNKNOWN at the injected deadline", async () => {
    __setRegistryDeadlineForTests(20);
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;
    const stuffed = { deadlineMs: 60000, registryDeadlineMs: 60000 };
    writeFileSync(policyPath, JSON.stringify({ ...POLICY, ...stuffed }));

    const result = await handleConsult(
      {
        ...stuffed,
        request: {
          ...PAY_MONAD,
          ...stuffed,
          action: { ...PAY_MONAD.action, ...stuffed },
        },
      },
      policyPath
    );

    expect(signal?.aborted).to.equal(true);
    expect(result.verdict).to.equal("UNKNOWN");
    expect(result.proceed).to.equal(false);
    expect(row(result, "asset-is-canonical")?.status).to.not.equal("PASS");
  });

  it("no RPC key configured answers unconfirmed, never a pass", async () => {
    delete process.env.HEDWIG_EVM_RPC_URL_143;
    __resetRegistryConfigForTests();
    const realError = console.error;
    const lines: string[] = [];
    console.error = (line: unknown) => lines.push(String(line));
    try {
      const result = await handleConsult({ request: PAY_MONAD }, policyPath);
      expect(row(result, "asset-is-canonical")?.status).to.not.equal("PASS");
      expect(result.proceed).to.equal(false);
    } finally {
      console.error = realError;
    }
    expect(logged()).to.not.include(RPC_URL);
    expect(lines).to.deep.equal(["HEDWIG_EVM_RPC_URL_143 is not set"]);
  });

  it("with no registry host configured nothing is fetched and the answer is UNKNOWN", async () => {
    delete process.env.HEDWIG_REGISTRY_URL;
    __resetRegistryConfigForTests();
    const realError = console.error;
    const lines: string[] = [];
    console.error = (line: unknown) => lines.push(String(line));
    try {
      const result = await handleConsult({ request: PAY_MONAD }, policyPath);
      expect(result.verdict).to.equal("UNKNOWN");
    } finally {
      console.error = realError;
    }
    expect(world.log).to.have.length(0);
    expect(lines).to.deep.equal(["HEDWIG_REGISTRY_URL is not set"]);
  });

  it("the shipped, empty keys with no host set log nothing about the host", async () => {
    delete process.env.HEDWIG_REGISTRY_URL;
    __resetRegistryConfigForTests();
    __setRegistryKeysForTests(undefined);
    const realError = console.error;
    const lines: string[] = [];
    console.error = (line: unknown) => lines.push(String(line));
    try {
      const result = await handleConsult({ request: PAY_MONAD }, policyPath);
      expect(result.verdict).to.equal("UNKNOWN");
    } finally {
      console.error = realError;
    }
    expect(world.log).to.have.length(0);
    expect(lines).to.deep.equal([]);
  });

  it("the shipped, empty keys reject every row and fetch nothing", async () => {
    __setRegistryKeysForTests(undefined);
    const result = await handleConsult({ request: PAY_MONAD }, policyPath);

    expect(result.verdict).to.equal("UNKNOWN");
    expect(row(result, "asset-is-canonical")?.status).to.not.equal("PASS");
    expect(world.log).to.have.length(0);
  });

  it("a request or a policy that names a host, an RPC or keys changes no URL and no key", async () => {
    const attacker = makeKeys();
    const attackerWorld = makeWorld(
      {
        [MONAD_PATH]: signed(
          monadUsdcRow({
            verifiedAt: iso(Date.now() - 3600 * 1000),
            expiresAt: iso(Date.now() + 86400 * 1000),
          }),
          attacker
        ),
      },
      monadChain()
    );
    world = attackerWorld;
    const stuffed = {
      registryUrl: "https://evil.test",
      registryBaseUrl: "https://evil.test",
      rpcUrl: "https://evil.test/rpc",
      rpcUrls: ["https://evil.test/rpc"],
      keys: attacker.pub,
      registryKeys: attacker.pub,
    };
    writeFileSync(policyPath, JSON.stringify({ ...POLICY, ...stuffed }));
    const result = await handleConsult(
      {
        request: {
          ...PAY_MONAD,
          ...stuffed,
          action: { ...PAY_MONAD.action, ...stuffed },
        },
        ...stuffed,
      },
      policyPath
    );

    expect(row(result, "asset-is-canonical")?.status).to.not.equal("PASS");
    for (const url of logged()) {
      expect(url === RPC_URL || url.startsWith(`${BASE}/v1/`)).to.equal(true);
    }
    expect(JSON.stringify(world.log)).to.not.include("evil.test");
  });

  it("runs beside the Solana Reader, not after it", async () => {
    process.env.HEDWIG_SOLANA_RPC_URL_DEVNET = SOLANA_URL;
    process.env.HEDWIG_SOLANA_FEE_PAYER_DEVNET = GOLDEN.feePayer;
    __resetSolanaClusterConfigForTests();
    writeFileSync(
      policyPath,
      JSON.stringify({
        ...POLICY,
        role: {
          mode: "required",
          cluster: "devnet",
          programId: GOLDEN.programId,
          role: GOLDEN.role,
          holder: GOLDEN.holder,
          maxAgeSeconds: 60,
        },
      })
    );
    const started = new Set<string>();
    let release: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Both readers must start before either fixture answers. Their own
    // deadlines still bound a regression that runs them in sequence.
    const gate = async (kind: string) => {
      started.add(kind);
      if (started.size === 2) {
        release();
      }
      await bothStarted;
    };
    const solanaBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        context: { slot: 12345 },
        value: {
          err: null,
          logs: [
            `Program ${GOLDEN.programId} invoke [1]`,
            `Program ${GOLDEN.programId} success`,
          ],
        },
      },
    });
    const inner = world.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === SOLANA_URL) {
        await gate("solana");
        return new Response(solanaBody, { status: 200 });
      }
      if (url === `${BASE}/${MONAD_PATH}`) {
        await gate("registry");
      }
      return inner(url, init);
    }) as typeof fetch;

    const result = await handleConsult({ request: PAY_MONAD }, policyPath);

    expect([...started]).to.have.members(["solana", "registry"]);
    expect(row(result, "asset-is-canonical")?.status).to.equal("PASS");
    expect(row(result, "role-requirement-met")?.status).to.equal("PASS");
  });
});
