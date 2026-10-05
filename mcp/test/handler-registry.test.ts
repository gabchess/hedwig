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
