import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { consult } from "@hedwig/consult";
import { handleConsult, __setRegistryKeysForTests } from "../src/handler";
import { pinPolicyFile } from "../src/policy";
import {
  __resetRegistryConfigForTests,
  __resetSolanaClusterConfigForTests,
} from "../src/readers/config";
import registryReader = require("../src/readers/registry-asset");
import solanaReader = require("../src/readers/solana-role");
import {
  BASE,
  RPC_URL,
  makeKeys,
  makeWorld,
  monadChain,
  monadUsdcRow,
  signed,
  type World,
} from "./registry-helpers";
import fixture from "../../consult/test/fixtures/monad-router02.json";
import golden from "./fixtures/solana-role/check-role-golden.json";

const router = "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900";
const owner = fixture.expected.recipient;
const now = 1791320100;
const solanaUrl = "https://solana.test/";
const registryPath = "v1/eip155-143/USDC.json";
const issuerSource = {
  origin: "circle.com",
  url: "https://developers.circle.com/stablecoins/usdc-contract-addresses",
  retrievedAt: now - 3600,
};
const policy = {
  permits: false,
  chainId: "eip155:143",
  approvedRecipients: [owner],
  perActionCaps: { swap: "10000000000000000000" },
  ownerAddresses: [owner],
  maxSlippageBps: 100,
  maxDeadlineSeconds: 600,
  role: {
    mode: "required",
    cluster: "devnet",
    programId: golden.programId,
    role: golden.role,
    holder: golden.holder,
    maxAgeSeconds: 60,
  },
};
const floorIds = [
  "target-is-canonical",
  "token-in-is-canonical",
  "token-out-is-canonical",
  "slippage-within-ceiling",
  "deadline-set-and-fresh",
  "output-recipient-is-owner",
  "approval-scoped-to-this-swap",
  "amount-within-cap",
  "chain-matches-intent",
  "role-requirement-met",
  "transaction-matches-intent",
];
const envNames = [
  "HEDWIG_REGISTRY_URL",
  "HEDWIG_REGISTRY_RATCHET_FILE",
  "HEDWIG_EVM_RPC_URL_143",
  "HEDWIG_SOLANA_RPC_URL_DEVNET",
  "HEDWIG_SOLANA_FEE_PAYER_DEVNET",
] as const;
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
  const keys = makeKeys();
  let dir: string;
  let policyPath: string;
  let world: World;
  let readerCalls: string[];
  let fetchCalls: string[];
  let originalFetch: typeof fetch;
  let originalNow: typeof Date.now;
  let originalRegistry: typeof registryReader.gatherRegistry;
  let originalSolana: typeof solanaReader.gatherSolanaRole;
  const originalEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-monad-binding-"));
    policyPath = join(dir, "policy.json");
    writeFileSync(policyPath, JSON.stringify(policy));
    const iso = (seconds: number) =>
      new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
    world = makeWorld(
      {
        [registryPath]: signed(
          monadUsdcRow({
            verifiedAt: iso(issuerSource.retrievedAt),
            expiresAt: iso(now + 3600),
            patch: {
              evidence: [
                { ...issuerSource, retrievedAt: iso(issuerSource.retrievedAt) },
              ],
            },
          }),
          keys
        ),
      },
      monadChain()
    );
    readerCalls = [];
    fetchCalls = [];
    originalRegistry = registryReader.gatherRegistry;
    originalSolana = solanaReader.gatherSolanaRole;
    // Call-through spies measure dispatch; the readers and consult stay real.
    registryReader.gatherRegistry = (...args) => {
      readerCalls.push("registry");
      return originalRegistry(...args);
    };
    solanaReader.gatherSolanaRole = (...args) => {
      readerCalls.push("solana");
      return originalSolana(...args);
    };
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      fetchCalls.push(String(input));
      if (String(input) === solanaUrl) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              context: { slot: 12345 },
              value: {
                err: null,
                logs: [
                  `Program ${golden.programId} invoke [1]`,
                  `Program ${golden.programId} success`,
                ],
              },
            },
          }),
          { status: 200 }
        );
      }
      return world.fetch(input, init);
    }) as typeof fetch;
    originalNow = Date.now;
    Date.now = () => now * 1000;
    for (const name of envNames) originalEnv[name] = process.env[name];
    process.env.HEDWIG_REGISTRY_URL = BASE;
    process.env.HEDWIG_REGISTRY_RATCHET_FILE = join(dir, "ratchet.json");
    process.env.HEDWIG_EVM_RPC_URL_143 = RPC_URL;
    process.env.HEDWIG_SOLANA_RPC_URL_DEVNET = solanaUrl;
    process.env.HEDWIG_SOLANA_FEE_PAYER_DEVNET = golden.feePayer;
    __resetRegistryConfigForTests();
    __resetSolanaClusterConfigForTests();
    __setRegistryKeysForTests(keys.pub);
  });
  afterEach(() => {
    registryReader.gatherRegistry = originalRegistry;
    solanaReader.gatherSolanaRole = originalSolana;
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
    __resetRegistryConfigForTests();
    __resetSolanaClusterConfigForTests();
    __setRegistryKeysForTests(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  const row = (result: Awaited<ReturnType<typeof handleConsult>>, id: string) =>
    result.results.find((item) => item.id === id);

  it("an unexpected preflight failure returns UNKNOWN without leaking or reading", async () => {
    Date.now = () => {
      throw new Error("private preflight context");
    };
    const result = await handleConsult({ request: request() }, policyPath);
    expect(result.verdict).to.equal("UNKNOWN");
    expect(result.proceed).to.equal(false);
    expect(result.support).to.equal(0);
    expect(row(result, "adapter")?.code).to.equal("ADAPTER_FAILED");
    expect(JSON.stringify(result)).to.not.include("private preflight context");
    expect(readerCalls).to.deep.equal([]);
    expect(fetchCalls).to.deep.equal([]);
  });

  for (const [name, tokenIn] of [
    ["extra native field", { kind: "native", symbol: "MON", extra: true }],
    ["unsupported native symbol", { kind: "native", symbol: "ETH" }],
  ] as const) {
    for (const [call, data] of [
      ["matching bytes", fixture.data],
      ["unsupported calldata", "0xdeadbeef"],
    ]) {
      it(`${name} with ${call} refuses before reader or fetch dispatch`, async () => {
        const input = request();
        const result = await handleConsult(
          {
            request: {
              ...input,
              action: { ...input.action, tokenIn },
              transaction: { ...input.transaction, data },
            },
          },
          policyPath
        );
        expect({ readers: readerCalls, fetches: fetchCalls }).to.deep.equal({
          readers: [],
          fetches: [],
        });
        expect(row(result, "target-is-canonical")).to.include({
          code: "MONAD_CALL_UNSUPPORTED",
          status: "UNVERIFIED",
          evidenceClass: "not-verifiable",
        });
        expect(result.floorIds).to.deep.equal(floorIds);
        expect(result.proceed).to.equal(false);
      });
    }
  }

  const unsupported: Array<[string, unknown]> = [
    ["missing transaction", undefined],
    ["malformed transaction", { ...request().transaction, from: "bad" }],
    [
      "signed proposal",
      { ...request().transaction, signedTransaction: "0xdeadbeef" },
    ],
    [
      "truncated calldata",
      { ...request().transaction, data: fixture.data.slice(0, -2) },
    ],
    [
      "non-hex calldata",
      { ...request().transaction, data: fixture.data.slice(0, -1) + "g" },
    ],
    [
      "unsupported selector",
      { ...request().transaction, data: "0xdeadbeef" + fixture.data.slice(10) },
    ],
    [
      "unsupported nested command",
      {
        ...request().transaction,
        data: fixture.data.replace("12210e8a", "deadbeef"),
      },
    ],
  ];
  for (const [name, transaction] of unsupported) {
    it(`${name} returns the full consult refusal before any reader or fetch dispatch`, async () => {
      const input = { ...request(), transaction, conditions: ["caller-extra"] };
      const result = await handleConsult(
        { request: input },
        policyPath,
        pinPolicyFile(policyPath)
      );
      expect(fetchCalls, "outbound fetch dispatches").to.deep.equal([]);
      expect(readerCalls, "evidence reader dispatches").to.deep.equal([]);
      expect(row(result, "target-is-canonical")).to.include({
        code: "MONAD_CALL_UNSUPPORTED",
        status: "UNVERIFIED",
        evidenceClass: "not-verifiable",
      });
      expect(result.floorIds).to.deep.equal(floorIds);
      expect(row(result, "caller-extra")?.code).to.equal("CONDITION_UNKNOWN");
      expect(row(result, "role-requirement-met")?.code).to.equal(
        "SWAP_ROLE_FACT_MISSING"
      );
      expect(row(result, "deadline-set-and-fresh")?.code).to.equal(
        "DEADLINE_FRESH"
      );
      expect(row(result, "approval-scoped-to-this-swap")?.code).to.equal(
        "SWAP_APPROVAL_NOT_SCOPED"
      );
      expect(result.verdict).to.equal("DENY");
      expect(result.proceed).to.equal(false);
      expect(result).to.deep.equal(
        consult(input as never, policy as never, { now })
      );
    });
  }

  const mismatches: Array<
    [string, (input: ReturnType<typeof request>) => void]
  > = [
    [
      "native value",
      (input) => {
        input.transaction.value = "1";
      },
    ],
    [
      "call target",
      (input) => {
        input.transaction.to = owner;
      },
    ],
    [
      "declared target",
      (input) => {
        input.action.target = owner;
      },
    ],
    [
      "caller-stated sender",
      (input) => {
        input.transaction.from = router;
      },
    ],
    [
      "recipient",
      (input) => {
        input.action.recipient = router;
      },
    ],
    [
      "input amount",
      (input) => {
        input.action.amountIn = "1";
      },
    ],
    [
      "output token",
      (input) => {
        input.action.tokenOut.contractAddress = router;
      },
    ],
    [
      "minimum output",
      (input) => {
        input.action.minOut = "1";
      },
    ],
    [
      "deadline",
      (input) => {
        input.action.deadline += 1;
      },
    ],
    [
      "approval amount",
      (input) => {
        input.action.approvalAmount = "1";
      },
    ],
  ];
  for (const [name, mutate] of mismatches) {
    it(`${name} mismatch denies before any reader or fetch dispatch`, async () => {
      const input = request();
      mutate(input);
      const result = await handleConsult({ request: input }, policyPath);
      expect(fetchCalls, "outbound fetch dispatches").to.deep.equal([]);
      expect(readerCalls, "evidence reader dispatches").to.deep.equal([]);
      expect(row(result, "target-is-canonical")).to.include({
        code: "MONAD_CALL_INTENT_MISMATCH",
        status: "FAIL",
        evidenceClass: "caller-stated",
      });
      expect(result.floorIds).to.deep.equal(floorIds);
      expect(result.verdict).to.equal("DENY");
      expect(result.support).to.equal(0);
      expect(result.proceed).to.equal(false);
      expect(result).to.deep.equal(
        consult(input as never, policy as never, { now })
      );
    });
  }

  it("preserves UNKNOWN when unsupported fields produce no failing mandatory check", async () => {
    const input = request();
    input.action.approvalAmount = "bad";
    const result = await handleConsult({ request: input }, policyPath);
    expect(fetchCalls).to.deep.equal([]);
    expect(readerCalls).to.deep.equal([]);
    expect(row(result, "target-is-canonical")?.code).to.equal(
      "MONAD_CALL_UNSUPPORTED"
    );
    expect(result.floorIds).to.deep.equal(floorIds);
    expect(result.verdict).to.equal("UNKNOWN");
    expect(result.proceed).to.equal(false);
  });

  it("a core refusal cannot send malformed native calldata to readers", async () => {
    writeFileSync(policyPath, "null");
    const input = request();
    input.transaction.data = "0xdeadbeef";
    const result = await handleConsult({ request: input }, policyPath);
    expect(fetchCalls).to.deep.equal([]);
    expect(readerCalls).to.deep.equal([]);
    expect(result.floorIds).to.deep.equal([]);
    expect(result.results[0].code).to.equal("INPUT_SHAPE_INVALID");
    expect(result.verdict).to.equal("UNKNOWN");
    expect(result).to.deep.equal(
      consult(input as never, null as never, { now })
    );
  });

  for (const [name, input, roleCode] of [
    [
      "non-Monad swap",
      {
        ...request(),
        action: { ...request().action, chainId: "eip155:1" },
        transaction: { ...request().transaction, data: "0xdeadbeef" },
      },
      "SWAP_ROLE_FACT_MISSING",
    ],
    [
      "Monad ERC-20 swap",
      {
        ...request(),
        action: {
          ...request().action,
          tokenIn: {
            symbol: "USDC",
            contractAddress: fixture.expected.outputAddress,
          },
        },
        transaction: { ...request().transaction, data: "0xdeadbeef" },
      },
      "SWAP_ROLE_FACT_MISSING",
    ],
    [
      "Solana payment",
      {
        action: {
          type: "pay",
          chainId: "solana:devnet",
          recipient: golden.holder,
          amount: "1",
        },
      },
      "ROLE_FACT_MISSING",
    ],
  ] as const) {
    it(`${name} refuses unsupported calls before evidence reader dispatch`, async () => {
      const result = await handleConsult({ request: input }, policyPath);
      expect(readerCalls).to.deep.equal([]);
      expect(fetchCalls).to.deep.equal([]);
      expect(result.proceed).to.equal(false);
      expect(row(result, "transaction-matches-intent")?.status).to.equal(
        "UNVERIFIED"
      );
      expect(row(result, "role-requirement-met")?.code).to.equal(roleCode);
      expect(
        result.results.some((item) => item.code.startsWith("MONAD_CALL_"))
      ).to.equal(false);
    });
  }

  it("matching bytes reach both required readers without enabling native execution", async () => {
    const result = await handleConsult({ request: request() }, policyPath);
    expect(readerCalls).to.deep.equal(["solana", "registry"]);
    expect(fetchCalls).to.include.members([
      solanaUrl,
      `${BASE}/${registryPath}`,
      RPC_URL,
    ]);
    expect(row(result, "target-is-canonical")?.code).to.equal(
      "SWAP_TARGET_ROUTER_UNKNOWN"
    );
    expect(row(result, "role-requirement-met")?.code).to.equal(
      "SWAP_ROLE_HELD"
    );
    expect(row(result, "token-out-is-canonical")?.status).to.equal("PASS");
    expect(result.floorIds).to.deep.equal(floorIds);
    expect(result.proceed).to.equal(false);
  });

  it("a bound fake USDC still reaches trusted evidence and retains the issuer-backed denial", async () => {
    const input = request();
    const fake = "77".repeat(20);
    input.action.tokenOut.contractAddress = `0x${fake}`;
    input.transaction.data =
      fixture.data.slice(0, 490) + fake + fixture.data.slice(530);
    const result = await handleConsult({ request: input }, policyPath);
    expect(readerCalls).to.deep.equal(["solana", "registry"]);
    expect(fetchCalls).to.include.members([
      solanaUrl,
      `${BASE}/${registryPath}`,
      RPC_URL,
    ]);
    expect(row(result, "token-out-is-canonical")?.code).to.equal(
      "SWAP_TOKEN_OUT_NOT_CANONICAL"
    );
    expect(row(result, "token-out-is-canonical")?.canonicalAsset).to.deep.equal(
      {
        chainId: "eip155:143",
        symbol: "USDC",
        contractAddress: fixture.expected.outputAddress,
        issuerSource,
      }
    );
    expect(result.verdict).to.equal("DENY");
    expect(result.proceed).to.equal(false);
    expect(result.support).to.equal(0);
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
