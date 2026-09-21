import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import {
  gatherSolanaRole,
  SIMULATE_DEADLINE_MS,
  type SolanaRoleDeps,
} from "../../src/readers/solana-role";
import {
  decodeBase58PublicKey,
  encodeBase58PublicKey,
} from "../../src/readers/wire";
import { findProgramAddress } from "../../src/readers/pda";

const GOLDEN = JSON.parse(
  readFileSync(
    join(__dirname, "..", "fixtures", "solana-role", "check-role-golden.json"),
    "utf8"
  )
);

// The real derived member PDA for GOLDEN.role / GOLDEN.holder / the
// deployed program id: gatherSolanaRole now derives this itself and never
// trusts a policy-supplied copy, so most fixtures below name no member at
// all. A handful of tests below need the correct value to test the
// mismatch and match paths explicitly.
const DERIVED_MEMBER = encodeBase58PublicKey(
  findProgramAddress(
    [
      Buffer.from("member"),
      decodeBase58PublicKey(GOLDEN.role) as Buffer,
      decodeBase58PublicKey(GOLDEN.holder) as Buffer,
    ],
    decodeBase58PublicKey(GOLDEN.programId) as Buffer
  )!.address
);

const REQUIRED_ROLE = {
  mode: "required",
  cluster: "devnet",
  programId: GOLDEN.programId,
  role: GOLDEN.role,
  holder: GOLDEN.holder,
  maxAgeSeconds: 60,
};

const RPC_URL = "https://api.devnet.solana.com/";

interface FetchCall {
  url: unknown;
  init: RequestInit;
}

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

const SUCCESS_LOGS = [
  `Program ${GOLDEN.programId} invoke [1]`,
  `Program ${GOLDEN.programId} success`,
];
const FAIL_LOGS = (custom: number): string[] => [
  `Program ${GOLDEN.programId} invoke [1]`,
  `Program log: AnchorError, Custom(${custom})`,
];

function rpcResult(
  overrides: {
    jsonrpc?: unknown;
    id?: unknown;
    slot?: unknown;
    err?: unknown;
    logs?: unknown;
  } = {}
): string {
  return JSON.stringify({
    jsonrpc: "jsonrpc" in overrides ? overrides.jsonrpc : "2.0",
    id: "id" in overrides ? overrides.id : 1,
    result: {
      context: { slot: "slot" in overrides ? overrides.slot : 12345 },
      value: {
        err: "err" in overrides ? overrides.err : null,
        logs: "logs" in overrides ? overrides.logs : SUCCESS_LOGS,
      },
    },
  });
}

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

describe("gatherSolanaRole: the member address is derived, never trusted (B3)", () => {
  it("member absent from the policy: derives the address and still calls out", async () => {
    const { fetch, calls } = fetchStub(() => fakeResponse(200, rpcResult()));
    const fact = await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }));
    expect(calls).to.have.length(1);
    expect(fact?.valid).to.equal(true);
  });

  it("member present and matching the derived address: calls out normally", async () => {
    const { fetch, calls } = fetchStub(() => fakeResponse(200, rpcResult()));
    const fact = await gatherSolanaRole(
      { ...REQUIRED_ROLE, member: DERIVED_MEMBER },
      baseDeps({ fetch })
    );
    expect(calls).to.have.length(1);
    expect(fact?.valid).to.equal(true);
  });

  it("member present and NOT matching the derived address: no call, no fact, one fixed line naming no address", async () => {
    const originalError = console.error;
    const errorLines: string[] = [];
    console.error = (...args: unknown[]) => errorLines.push(String(args[0]));
    try {
      const { fetch, calls } = fetchStub(() => fakeResponse(200, rpcResult()));
      const fact = await gatherSolanaRole(
        { ...REQUIRED_ROLE, member: GOLDEN.feePayer },
        baseDeps({ fetch })
      );
      expect(fact).to.equal(undefined);
      expect(calls).to.have.length(0);
      expect(errorLines).to.have.length(1);
      expect(errorLines[0]).to.not.include(GOLDEN.feePayer);
      expect(errorLines[0]).to.not.include(DERIVED_MEMBER);
    } finally {
      console.error = originalError;
    }
  });

  it("a real MemberMissing now truthfully means this holder never held the role", async () => {
    // With the derived address in play, Custom 3012 can no longer be
    // produced by a policy typo: the only way to reach it is a genuinely
    // absent member account for the (role, holder) the policy names.
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        rpcResult({
          err: { InstructionError: [0, { Custom: 3012 }] },
          logs: FAIL_LOGS(3012),
        })
      )
    );
    const fact = await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }));
    expect(fact?.valid).to.equal(false);
    expect(fact?.reason).to.equal("MemberMissing");
  });
});

describe("gatherSolanaRole: every account key must be distinct", () => {
  it("feePayer equal to holder: no call, no fact, one fixed line", async () => {
    const originalError = console.error;
    const errorLines: string[] = [];
    console.error = (...args: unknown[]) => errorLines.push(String(args[0]));
    try {
      const { fetch, calls } = fetchStub(() => fakeResponse(200, rpcResult()));
      const fact = await gatherSolanaRole(
        REQUIRED_ROLE,
        baseDeps({ fetch, feePayer: GOLDEN.holder })
      );
      expect(fact).to.equal(undefined);
      expect(calls).to.have.length(0);
      expect(errorLines).to.have.length(1);
    } finally {
      console.error = originalError;
    }
  });

  it("feePayer equal to role: no call, no fact", async () => {
    const { fetch, calls } = fetchStub(() => fakeResponse(200, rpcResult()));
    const fact = await gatherSolanaRole(
      REQUIRED_ROLE,
      baseDeps({ fetch, feePayer: GOLDEN.role })
    );
    expect(fact).to.equal(undefined);
    expect(calls).to.have.length(0);
  });

  it("feePayer equal to the derived member: no call, no fact", async () => {
    const { fetch, calls } = fetchStub(() => fakeResponse(200, rpcResult()));
    const fact = await gatherSolanaRole(
      REQUIRED_ROLE,
      baseDeps({ fetch, feePayer: DERIVED_MEMBER })
    );
    expect(fact).to.equal(undefined);
    expect(calls).to.have.length(0);
  });
});

describe("gatherSolanaRole: valid true requires the program's own success line (S1)", () => {
  const badShapes: Array<[string, unknown]> = [
    ['logs is [""]', [""]],
    ["logs is [null]", [null]],
    ["logs is [123, {}]", [123, {}]],
    [
      "logs has a failed line for this program",
      [
        `Program ${GOLDEN.programId} invoke [1]`,
        `Program ${GOLDEN.programId} failed`,
      ],
    ],
    [
      "logs has the success line AND a failed line in the form the runtime writes",
      [
        `Program ${GOLDEN.programId} invoke [1]`,
        `Program ${GOLDEN.programId} failed: custom program error: 0x1`,
        `Program ${GOLDEN.programId} success`,
      ],
    ],
    [
      "logs has the success line AND a bare failed line",
      [
        `Program ${GOLDEN.programId} invoke [1]`,
        `Program ${GOLDEN.programId} failed`,
        `Program ${GOLDEN.programId} success`,
      ],
    ],
    [
      "logs only quotes the success line inside a program log",
      [
        `Program ${GOLDEN.programId} invoke [1]`,
        `Program log: Program ${GOLDEN.programId} success`,
      ],
    ],
    [
      "logs has the success line with trailing text",
      [
        `Program ${GOLDEN.programId} invoke [1]`,
        `Program ${GOLDEN.programId} success extra`,
      ],
    ],
    [
      "logs names a different program's success",
      ["Program 11111111111111111111111111111111 success"],
    ],
  ];

  badShapes.forEach(([label, logs]) => {
    it(`${label}: no fact`, async () => {
      const { fetch } = fetchStub(() =>
        fakeResponse(200, rpcResult({ err: null, logs }))
      );
      expect(
        await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))
      ).to.equal(undefined);
    });
  });

  it("slot 0: no fact (valid true requires a positive slot)", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(200, rpcResult({ slot: 0, err: null }))
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("a JSON-RPC id that does not match the one sent: no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(200, rpcResult({ id: 2, err: null }))
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("a body with no jsonrpc field: no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        JSON.stringify({
          id: 1,
          result: {
            context: { slot: 1 },
            value: { err: null, logs: SUCCESS_LOGS },
          },
        })
      )
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("a body with no id field: no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        JSON.stringify({
          jsonrpc: "2.0",
          result: {
            context: { slot: 1 },
            value: { err: null, logs: SUCCESS_LOGS },
          },
        })
      )
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("a real success answers valid true", async () => {
    const { fetch } = fetchStub(() => fakeResponse(200, rpcResult()));
    const fact = await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }));
    expect(fact?.valid).to.equal(true);
    expect(fact?.reason).to.equal("ok");
  });
});

describe("gatherSolanaRole: a valid:false reason requires the program's invoke line (S1)", () => {
  it("Custom 3012 with empty logs: no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        rpcResult({
          err: { InstructionError: [0, { Custom: 3012 }] },
          logs: [],
        })
      )
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("logs that never name this program's invoke: no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        rpcResult({
          err: { InstructionError: [0, { Custom: 3012 }] },
          logs: ["Program log: something"],
        })
      )
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("a sibling key beside Custom: no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        rpcResult({
          err: { InstructionError: [0, { Custom: 3012, Other: 1 }] },
          logs: FAIL_LOGS(3012),
        })
      )
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });
});

describe("gatherSolanaRole: the failure map", () => {
  it("Custom 6004: RoleDisabled", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        rpcResult({
          err: { InstructionError: [0, { Custom: 6004 }] },
          logs: FAIL_LOGS(6004),
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
          logs: FAIL_LOGS(6005),
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
              logs: FAIL_LOGS(code),
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
          logs: FAIL_LOGS(3012),
        })
      )
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("a three-element InstructionError pair: no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        rpcResult({
          err: { InstructionError: [0, { Custom: 3012 }, "extra"] },
          logs: FAIL_LOGS(3012),
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

  it("Custom code as a non-integer number (3012.5): no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        rpcResult({
          err: { InstructionError: [0, { Custom: 3012.5 }] },
          logs: FAIL_LOGS(3012),
        })
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
          logs: FAIL_LOGS(9999),
        })
      )
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("err null with empty logs: no fact (kills the 'treated as valid true' mutant)", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(200, rpcResult({ err: null, logs: [] }))
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  [-1, 1.5, "5", 2 ** 53].forEach((slot) => {
    it(`slot ${slot}: no fact`, async () => {
      const { fetch } = fetchStub(() => fakeResponse(200, rpcResult({ slot })));
      expect(
        await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))
      ).to.equal(undefined);
    });
  });

  it("result and error both present: no fact", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(
        200,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            context: { slot: 1 },
            value: { err: null, logs: SUCCESS_LOGS },
          },
          error: { code: -1, message: "also an error" },
        })
      )
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  [301, 302].forEach((status) => {
    it(`HTTP ${status}: no fact`, async () => {
      const { fetch } = fetchStub(() => fakeResponse(status, rpcResult()));
      expect(
        await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))
      ).to.equal(undefined);
    });
  });

  it("HTTP 500 means fetch was called exactly once, no retry", async () => {
    const { fetch, calls } = fetchStub(() => fakeResponse(500, rpcResult()));
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
    expect(calls).to.have.length(1);
  });

  it("response.redirected true after a 200: no fact (a fetch that ignores redirect: error)", async () => {
    const { fetch } = fetchStub(() =>
      fakeResponse(200, rpcResult(), { redirected: true })
    );
    expect(await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }))).to.equal(
      undefined
    );
  });

  it("a 300 KB valid-JSON success body: no fact (kills the 'cap removed' mutant)", async () => {
    const padded = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        context: { slot: 12345 },
        value: { err: null, logs: [...SUCCESS_LOGS, "x".repeat(300 * 1024)] },
      },
    });
    const { fetch } = fetchStub(() => fakeResponse(200, padded));
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

describe("gatherSolanaRole: one deadline for the whole exchange (B1)", () => {
  it("headers arrive but the body never ends: no fact within the deadline", async () => {
    const fetch = (async (_url: unknown, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      return {
        status: 200,
        redirected: false,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            );
          }),
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const fact = await gatherSolanaRole(
      REQUIRED_ROLE,
      baseDeps({ fetch, deadlineMs: 20 })
    );
    expect(fact).to.equal(undefined);
  }).timeout(2000);

  it("a body that completes after the deadline: no fact, never a real long sleep", async () => {
    const fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return fakeResponse(200, rpcResult());
    }) as unknown as typeof globalThis.fetch;

    const fact = await gatherSolanaRole(
      REQUIRED_ROLE,
      baseDeps({ fetch, deadlineMs: 5 })
    );
    expect(fact).to.equal(undefined);
  }).timeout(2000);

  it("signal.aborted is true after the deadline (kills the 'abort removed' mutant)", async () => {
    let signal: AbortSignal | undefined;
    const fetch = (async (_url: unknown, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>(() => {
        // never resolves
      });
    }) as unknown as typeof globalThis.fetch;

    await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch, deadlineMs: 10 }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(signal?.aborted).to.equal(true);
  }).timeout(2000);
});

describe("gatherSolanaRole: the size cap bounds memory, not just rejects afterward (B2)", () => {
  function endlessStreamResponse(chunkBytes: number): {
    response: Response;
    getReadCount: () => number;
  } {
    let reads = 0;
    const chunk = new Uint8Array(chunkBytes).fill(65);
    const reader = {
      read: async () => {
        reads++;
        return { done: false, value: chunk };
      },
      cancel: async () => undefined,
    };
    const response = {
      status: 200,
      redirected: false,
      body: { getReader: () => reader },
      text: async () => {
        throw new Error("text() must not be used when a stream is present");
      },
    } as unknown as Response;
    return { response, getReadCount: () => reads };
  }

  it("an endless chunked body is cut off, never read forever", async () => {
    const { response, getReadCount } = endlessStreamResponse(64 * 1024);
    const fetch = (async () => response) as unknown as typeof globalThis.fetch;

    const fact = await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }));

    expect(fact).to.equal(undefined);
    // 256 KB cap / 64 KB chunks = 4 chunks to reach the cap, one more to
    // pass it: bounded well under "forever".
    expect(getReadCount()).to.be.lessThan(20);
  });
});

describe("gatherSolanaRole: the request params are exactly what the spec requires (S5)", () => {
  it("sends sigVerify: false and commitment: confirmed exactly", async () => {
    const { fetch, calls } = fetchStub(() => fakeResponse(200, rpcResult()));
    await gatherSolanaRole(REQUIRED_ROLE, baseDeps({ fetch }));
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.params[1].sigVerify).to.equal(false);
    expect(body.params[1].commitment).to.equal("confirmed");
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
      now();
      return fakeResponse(200, rpcResult());
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
    const { fetch } = fetchStub(() => fakeResponse(200, rpcResult()));
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
