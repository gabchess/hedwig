import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import {
  gatherSolanaRole,
  SIMULATE_DEADLINE_MS,
  type SolanaRoleDeps,
} from "../../src/readers/solana-role";

const GOLDEN = JSON.parse(
  readFileSync(
    join(__dirname, "..", "fixtures", "solana-role", "check-role-golden.json"),
    "utf8"
  )
);

const REQUIRED_ROLE = {
  mode: "required",
  cluster: "devnet",
  programId: GOLDEN.programId,
  role: GOLDEN.role,
  holder: GOLDEN.holder,
  member: GOLDEN.member,
  maxAgeSeconds: 60,
};

const RPC_URL = "https://api.devnet.solana.com/";

interface FetchCall {
  url: unknown;
  init: RequestInit;
}

function fakeResponse(status: number, body: string): Response {
  return { status, text: async () => body } as unknown as Response;
}

function fetchStub(
  handler: (url: unknown, init: RequestInit) => Promise<Response> | Response
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function baseDeps(overrides: Partial<SolanaRoleDeps> = {}): SolanaRoleDeps {
  return {
    fetch: fetchStub(() => fakeResponse(200, rpcResult())).fetch,
    now: () => 1_700_000_000,
    feePayer: GOLDEN.feePayer,
    rpcUrl: RPC_URL,
    deadlineMs: SIMULATE_DEADLINE_MS,
    ...overrides,
  };
}

function rpcResult(
  overrides: { slot?: unknown; err?: unknown; logs?: unknown } = {}
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      context: { slot: "slot" in overrides ? overrides.slot : 12345 },
      value: {
        err: "err" in overrides ? overrides.err : null,
        logs: "logs" in overrides ? overrides.logs : ["Program log: ok"],
      },
    },
  });
}

const OK_LOGS = ["Program log: Instruction: CheckRole", "Program log: success"];

describe("gatherSolanaRole: no call, no fact", () => {
  it("mode not-required: no call", async () => {
    const { fetch, calls } = fetchStub(() => fakeResponse(200, rpcResult()));
    const fact = await gatherSolanaRole(
      { mode: "not-required" },
      baseDeps({ fetch })
    );
    expect(fact).to.equal(undefined);
    expect(calls).to.have.length(0);
  });

  it("cluster testnet: no config, no call", async () => {
    const { fetch, calls } = fetchStub(() => fakeResponse(200, rpcResult()));
    const fact = await gatherSolanaRole(
      { ...REQUIRED_ROLE, cluster: "testnet" },
      baseDeps({ fetch })
    );
    expect(fact).to.equal(undefined);
    expect(calls).to.have.length(0);
  });

  it("programId not the deployed id: no call", async () => {
    const { fetch, calls } = fetchStub(() => fakeResponse(200, rpcResult()));
    const fact = await gatherSolanaRole(
      { ...REQUIRED_ROLE, programId: GOLDEN.role },
      baseDeps({ fetch })
    );
    expect(fact).to.equal(undefined);
    expect(calls).to.have.length(0);
  });

  it("member missing from the policy: no call", async () => {
    const { member: _member, ...policyRole } = REQUIRED_ROLE as Record<
      string,
      unknown
    >;
    const { fetch, calls } = fetchStub(() => fakeResponse(200, rpcResult()));
    const fact = await gatherSolanaRole(policyRole, baseDeps({ fetch }));
    expect(fact).to.equal(undefined);
    expect(calls).to.have.length(0);
  });

  it("a malformed role/holder key: no call", async () => {
    const { fetch, calls } = fetchStub(() => fakeResponse(200, rpcResult()));
    const fact = await gatherSolanaRole(
      { ...REQUIRED_ROLE, holder: "not-base58" },
      baseDeps({ fetch })
    );
    expect(fact).to.equal(undefined);
    expect(calls).to.have.length(0);
  });

  it("no fee payer configured for the cluster: no call", async () => {
    const { fetch, calls } = fetchStub(() => fakeResponse(200, rpcResult()));
    const fact = await gatherSolanaRole(
      REQUIRED_ROLE,
      baseDeps({ fetch, feePayer: undefined })
    );
    expect(fact).to.equal(undefined);
    expect(calls).to.have.length(0);
  });

  it("no RPC URL configured for the cluster: no call", async () => {
    const { fetch, calls } = fetchStub(() => fakeResponse(200, rpcResult()));
    const fact = await gatherSolanaRole(
      REQUIRED_ROLE,
      baseDeps({ fetch, rpcUrl: undefined })
    );
    expect(fact).to.equal(undefined);
    expect(calls).to.have.length(0);
  });
});

describe("gatherSolanaRole: the failure map", () => {
  it("err null, non-empty logs, a safe slot: valid true, ok", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(200, rpcResult({ err: null, logs: OK_LOGS }))
    );
    const fact = await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }));
    expect(fact?.valid).to.equal(true);
    expect(fact?.reason).to.equal("ok");
    expect(fact?.subject).to.deep.equal({
      cluster: "devnet",
      programId: GOLDEN.programId,
      role: GOLDEN.role,
      holder: GOLDEN.holder,
    });
  });

  it("Custom 3012 at instruction index 0: MemberMissing", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        rpcResult({
          err: { InstructionError: [0, { Custom: 3012 }] },
          logs: ["AnchorError: AccountNotInitialized"],
        })
      )
    );
    const fact = await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }));
    expect(fact?.valid).to.equal(false);
    expect(fact?.reason).to.equal("MemberMissing");
  });

  it("Custom 6004: RoleDisabled", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        rpcResult({
          err: { InstructionError: [0, { Custom: 6004 }] },
          logs: ["AnchorError: RoleDisabled"],
        })
      )
    );
    const fact = await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }));
    expect(fact?.valid).to.equal(false);
    expect(fact?.reason).to.equal("RoleDisabled");
  });

  it("Custom 6005: MembershipExpired", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        rpcResult({
          err: { InstructionError: [0, { Custom: 6005 }] },
          logs: ["AnchorError: MembershipExpired"],
        })
      )
    );
    const fact = await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }));
    expect(fact?.valid).to.equal(false);
    expect(fact?.reason).to.equal("MembershipExpired");
  });

  [2001, 2006, 3002, 3007, 6000, 6001, 6002, 6003].forEach((code) => {
    it(`Custom ${code}: a configuration defect, no fact`, async () => {
      const originalError = console.error;
      const errorLines: unknown[] = [];
      console.error = (...args: unknown[]) => errorLines.push(args);
      try {
        const { fetch } = fetchStub(() =>
          fakeResponse(
            200,
            rpcResult({
              err: { InstructionError: [0, { Custom: code }] },
              logs: ["AnchorError: some constraint"],
            })
          )
        );
        const fact = await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }));
        expect(fact).to.equal(undefined);
        expect(errorLines).to.have.length(1);
        expect(String(errorLines[0])).to.not.include(RPC_URL);
        expect(String(errorLines[0])).to.not.include(GOLDEN.holder);
      } finally {
        console.error = originalError;
      }
    });
  });

  it("a bare-string err: no fact (never reports a verdict from a transport shape)", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(200, rpcResult({ err: "BlockhashNotFound", logs: [] }))
    );
    const fact = await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }));
    expect(fact).to.equal(undefined);
  });

  it("err as a number: no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(200, rpcResult({ err: 42 }))
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("err as an array: no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(200, rpcResult({ err: [1, 2, 3] }))
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("err as a nested object with extra top-level keys: no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        rpcResult({
          err: { InstructionError: [0, { Custom: 3012 }], extra: "junk" },
        })
      )
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("InstructionError at index 1, not 0: no fact (kills the 'any index' mutant)", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        rpcResult({
          err: { InstructionError: [1, { Custom: 3012 }] },
          logs: ["irrelevant"],
        })
      )
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("Custom code as a string: no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        rpcResult({ err: { InstructionError: [0, { Custom: "3012" }] } })
      )
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("InstructionError detail is a bare string: no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(200, rpcResult({ err: { InstructionError: [0, "Custom"] } }))
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("an unknown Custom code: no fact (kills the 'treated as valid false' mutant)", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        rpcResult({
          err: { InstructionError: [0, { Custom: 9999 }] },
          logs: ["irrelevant"],
        })
      )
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  [null, [], "not-an-array"].forEach((logs) => {
    it(`logs ${JSON.stringify(logs)} with err null: no fact`, async () => {
      const { fetch } = fetchStub(() =>
        fakeResponse(200, rpcResult({ err: null, logs }))
      );
      expect(
        await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))
      ).to.equal(undefined);
    });
  });

  it("err null with empty logs: no fact (kills the 'treated as valid true' mutant)", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(200, rpcResult({ err: null, logs: [] }))
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("slot 0: a fact (zero is a legitimate slot)", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(200, rpcResult({ slot: 0, err: null, logs: OK_LOGS }))
    );
    const fact = await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }));
    expect(fact?.provenance.slot).to.equal(0);
  });

  [-1, 1.5, "5", 2 ** 53].forEach((slot) => {
    it(`slot ${slot}: no fact`, async () => {
      const { fetch } = fetchStub(() =>
        fakeResponse(200, rpcResult({ slot, err: null, logs: OK_LOGS }))
      );
      expect(
        await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))
      ).to.equal(undefined);
    });
  });

  [301, 302, 500].forEach((status) => {
    it(`HTTP ${status}: no fact`, async () => {
      const { fetch } = fetchStub(() => fakeResponse(status, rpcResult()));
      expect(
        await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))
      ).to.equal(undefined);
    });
  });

  it("a 300 KB body: no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(200, "x".repeat(300 * 1024))
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("a non-JSON body: no fact", async () => {
    const { fetch } = fetchStub(() => fakeResponse(200, "not json at all"));
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("JSON with result missing: no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(200, JSON.stringify({ jsonrpc: "2.0", id: 1 }))
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("a JSON-RPC top-level error: no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "invalid params" },
        })
      )
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("a fetch that resolves after the deadline: no fact, never a real 900ms sleep", async () => {
    const fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return fakeResponse(200, rpcResult({ err: null, logs: OK_LOGS }));
    }) as unknown as typeof globalThis.fetch;

    const fact = await gatherSolanaRole(
      REQUIRED_ROLE,
      baseDeps({ fetch, deadlineMs: 5 })
    );
    expect(fact).to.equal(undefined);
  }).timeout(2000);

  it("a fetch that rejects: no fact", async () => {
    const fetch = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof globalThis.fetch;
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("a fetch that throws synchronously: no fact", async () => {
    const fetch = (() => {
      throw new Error("boom");
    }) as unknown as typeof globalThis.fetch;
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("a now() that throws: no fact", async () => {
    const now = () => {
      throw new Error("clock unavailable");
    };
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ now }))).to.equal(
      undefined
    );
  });
});

describe("gatherSolanaRole: the outbound call itself", () => {
  it("sends redirect: error (kills the 'redirect removed' mutant)", async () => {
    const { fetch, calls } = fetchStub(() => fakeResponse(200, rpcResult()));
    await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }));
    expect(calls).to.have.length(1);
    expect(calls[0].init.redirect).to.equal("error");
  });

  it("makes exactly one outbound call per gather", async () => {
    const { fetch, calls } = fetchStub(() => fakeResponse(200, rpcResult()));
    await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }));
    expect(calls).to.have.length(1);
  });

  it("takes observedAt before the send, not after the response (kills the 'taken after' mutant)", async () => {
    let calls = 0;
    const now = () => {
      calls++;
      return calls === 1 ? 1_000 : 999_999;
    };
    const fetch = (async () => {
      // A response that arrives only after time has "moved on": if
      // observedAt were read here instead of before the send, it would
      // pick up the later value.
      now();
      return fakeResponse(200, rpcResult({ err: null, logs: OK_LOGS }));
    }) as unknown as typeof globalThis.fetch;

    const fact = await gatherSolanaRole(
      REQUIRED_ROLE,
      baseDeps({ fetch, now })
    );
    expect(fact?.provenance.observedAt).to.equal(1_000);
  });

  it("provenance.source is the RPC URL's host only, never the full URL (kills the 'full URL' mutant)", async () => {
    const secretRpcUrl =
      "https://rpc.example.com/v1?api-key=super-secret-value";
    const { fetch } = fetchStub(() =>
      fakeResponse(200, rpcResult({ err: null, logs: OK_LOGS }))
    );
    const fact = await gatherSolanaRole(
      REQUIRED_ROLE,
      baseDeps({ fetch, rpcUrl: secretRpcUrl })
    );
    expect(fact?.provenance.source).to.equal("rpc.example.com");
    expect(fact?.provenance.source).to.not.include("super-secret-value");
    expect(fact?.provenance.source).to.not.include("/v1");
    expect(fact?.provenance.source).to.not.include("https://");
  });
});
