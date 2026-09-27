import { expect } from "chai";

import { runTriggerGuard } from "../src/guard";
import type { TriggerGuardInput } from "../src/guard";
import { runTriggerGuardWith } from "../src/guard-internal";
import type { ConsultFn } from "../src/guard-internal";
import type { ConsultResponse } from "../src";
import type { ConsultAction, ConsultRequest } from "../src/catalog";
import { UNAPPROVED_RECIPIENT, makePolicy, makeRequest } from "./fixtures";

// The Trigger guard's own seam: runTriggerGuard, the public door
// (consult/src/guard.ts), for the behaviors an external caller can drive.
// Two defensive branches (consult() throwing, consult() returning a
// malformed verdict) are only reachable through the test-only
// runTriggerGuardWith seam (consult/src/guard-internal.ts): the public
// door never accepts a substitute verdict function, so those two branches have
// no other way in.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Asserts value has the shape of a frozen JSON snapshot all the way down:
// primitives, arrays that carry only their own index properties, and
// null-prototype records. Nothing else can hold state a later write could
// change. This checks shape only; a caller's own frozen null-prototype
// object would pass without being a snapshot the guard actually made.
function expectSnapshotData(value: unknown, path = "value"): void {
  if (value === null) return;
  if (typeof value !== "object") {
    expect(typeof value, path).to.be.oneOf(["string", "number", "boolean"]);
    return;
  }
  expect(Object.isFrozen(value), `${path} frozen`).to.equal(true);
  if (Array.isArray(value)) {
    expect(Object.getPrototypeOf(value), path).to.equal(Array.prototype);
    expect(Reflect.ownKeys(value), `${path} keys`).to.deep.equal(
      [...value.keys()].map(String).concat("length")
    );
    value.forEach((item, index) =>
      expectSnapshotData(item, `${path}[${index}]`)
    );
    return;
  }
  expect(Object.getPrototypeOf(value), `${path} prototype`).to.equal(null);
  for (const key of Reflect.ownKeys(value)) {
    expect(typeof key, `${path} key`).to.equal("string");
    expectSnapshotData(
      (value as Record<string, unknown>)[key as string],
      `${path}.${String(key)}`
    );
  }
}

function baseInput(
  overrides: Partial<TriggerGuardInput<ConsultRequest, string>> = {}
): TriggerGuardInput<ConsultRequest, string> {
  const request = makeRequest();
  return {
    payment: request,
    toRequest: (payment) => payment,
    policy: makePolicy(),
    signer: () => "SIGNED",
    ...overrides,
  };
}

describe("runTriggerGuard", () => {
  it("ALLOW_UNDER_POLICY: calls the signer exactly once, with a frozen copy equal in value to the caller's action", async () => {
    const request = makeRequest();
    const calls: ConsultAction[] = [];
    const result = await runTriggerGuard(
      baseInput({
        payment: request,
        toRequest: (payment) => payment,
        signer: (action) => {
          calls.push(action);
          return "SIGNED";
        },
      })
    );

    expect(result.consult.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(result.signerOutcome).to.equal("settled");
    expect(result.signerResult).to.equal("SIGNED");
    expect(calls).to.have.length(1);
    // Deep-equal on values, not object identity: the signer gets a
    // frozen JSON copy, never the caller's own live object.
    // A re-map mutant that hands the signer a second live read of
    // request.action would still pass a deep-equal check here, which is
    // why the getter/mutation regressions below exist as well.
    expect(calls[0]).to.deep.equal(request.action);
    expect(Object.isFrozen(calls[0])).to.equal(true);
  });

  it("DENY: never calls the signer", async () => {
    const request = makeRequest({
      action: { ...makeRequest().action, recipient: UNAPPROVED_RECIPIENT },
    });
    let signerCalls = 0;
    const result = await runTriggerGuard(
      baseInput({
        payment: request,
        toRequest: (payment) => payment,
        signer: () => {
          signerCalls += 1;
          return "SIGNED";
        },
      })
    );

    expect(result.consult.verdict).to.equal("DENY");
    expect(result.signerOutcome).to.equal("not-attempted");
    expect(signerCalls).to.equal(0);
  });

  it("UNKNOWN: never calls the signer", async () => {
    let signerCalls = 0;
    const result = await runTriggerGuard(
      baseInput({
        policy: makePolicy({ permits: false }),
        signer: () => {
          signerCalls += 1;
          return "SIGNED";
        },
      })
    );

    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.signerOutcome).to.equal("not-attempted");
    expect(signerCalls).to.equal(0);
  });

  it("a thrown mapping error never calls the signer and comes back UNKNOWN-shaped", async () => {
    let signerCalls = 0;
    const result = await runTriggerGuard(
      baseInput({
        toRequest: () => {
          throw new Error("cannot map this payment");
        },
        signer: () => {
          signerCalls += 1;
          return "SIGNED";
        },
      })
    );

    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.proceed).to.equal(false);
    expect(result.consult.results[0].code).to.equal("GUARD_MAPPING_FAILED");
    expect(result.signerOutcome).to.equal("not-attempted");
    expect(signerCalls).to.equal(0);
  });

  it("a thrown gather error never calls the signer and comes back UNKNOWN-shaped", async () => {
    let signerCalls = 0;
    const result = await runTriggerGuard(
      baseInput({
        gather: () => {
          throw new Error("cannot reach the chain");
        },
        signer: () => {
          signerCalls += 1;
          return "SIGNED";
        },
      })
    );

    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.results[0].code).to.equal("GUARD_GATHER_FAILED");
    expect(result.signerOutcome).to.equal("not-attempted");
    expect(signerCalls).to.equal(0);
  });

  it("a gather step that misses its deadline gives UNKNOWN, is never retried, and never calls the signer", async () => {
    let gatherCalls = 0;
    let signerCalls = 0;
    const result = await runTriggerGuard(
      baseInput({
        gather: async () => {
          gatherCalls += 1;
          await sleep(50);
          return { now: 1 };
        },
        gatherDeadlineMs: 5,
        signer: () => {
          signerCalls += 1;
          return "SIGNED";
        },
      })
    );

    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.results[0].code).to.equal("GUARD_GATHER_TIMED_OUT");
    expect(gatherCalls).to.equal(1);
    expect(signerCalls).to.equal(0);
  });

  it("a consult() that throws never calls the signer and comes back UNKNOWN-shaped (test-only seam)", async () => {
    const throwingConsult: ConsultFn = () => {
      throw new Error("catalog exploded");
    };
    let signerCalls = 0;
    const result = await runTriggerGuardWith(
      throwingConsult,
      baseInput({
        signer: () => {
          signerCalls += 1;
          return "SIGNED";
        },
      })
    );

    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.results[0].code).to.equal("GUARD_CONSULT_THREW");
    expect(signerCalls).to.equal(0);
  });

  it("a malformed verdict from consult() never calls the signer and comes back UNKNOWN-shaped (test-only seam)", async () => {
    const malformedConsult = (() => ({
      verdict: "MOSTLY_FINE",
    })) as unknown as ConsultFn;
    let signerCalls = 0;
    const result = await runTriggerGuardWith(
      malformedConsult,
      baseInput({
        signer: () => {
          signerCalls += 1;
          return "SIGNED";
        },
      })
    );

    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.results[0].code).to.equal("GUARD_MALFORMED_VERDICT");
    expect(signerCalls).to.equal(0);
  });

  it("a signer that misses its deadline reports the outcome as unknown, once, with no retry", async () => {
    let signerCalls = 0;
    const result = await runTriggerGuard(
      baseInput({
        signer: async () => {
          signerCalls += 1;
          await sleep(50);
          return "SIGNED";
        },
        signerDeadlineMs: 5,
      })
    );

    expect(result.consult.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(result.signerOutcome).to.equal("unknown");
    expect(result.signerResult).to.equal(undefined);
    await sleep(60);
    expect(signerCalls).to.equal(1);
  });

  it("a signer that rejects reports the outcome as unknown, once, with no retry", async () => {
    let signerCalls = 0;
    const result = await runTriggerGuard(
      baseInput({
        signer: async () => {
          signerCalls += 1;
          throw new Error("wallet locked");
        },
      })
    );

    expect(result.consult.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(result.signerOutcome).to.equal("unknown");
    expect(signerCalls).to.equal(1);
  });

  it("a getter on request.action that changes after its first read: ALLOW_UNDER_POLICY, and the signer gets the first value", async () => {
    const good = makeRequest().action;
    const evil = {
      ...good,
      recipient: UNAPPROVED_RECIPIENT,
      amount: "999999999999",
    };
    let reads = 0;
    const req = {
      get action() {
        reads += 1;
        return reads === 1 ? good : evil;
      },
    } as unknown as ConsultRequest;
    const signed: ConsultAction[] = [];
    const result = await runTriggerGuard(
      baseInput({
        payment: req,
        toRequest: (p) => p,
        signer: (action) => {
          signed.push(action);
          return "SIGNED";
        },
      })
    );
    expect(result.consult.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(signed).to.have.length(1);
    expect(signed[0].recipient).to.equal(good.recipient);
    expect(signed[0].amount).to.equal(good.amount);
  });

  it("a getter on action.recipient that changes after its first read: ALLOW_UNDER_POLICY, and the signer gets the first value", async () => {
    const base = makeRequest();
    let reads = 0;
    const action = { ...base.action } as Record<string, unknown>;
    delete action.recipient;
    Object.defineProperty(action, "recipient", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? base.action.recipient : UNAPPROVED_RECIPIENT;
      },
    });
    const req = { action } as unknown as ConsultRequest;
    const signed: ConsultAction[] = [];
    const result = await runTriggerGuard(
      baseInput({
        payment: req,
        toRequest: (p) => p,
        signer: (a) => {
          signed.push(a);
          return "SIGNED";
        },
      })
    );
    expect(result.consult.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(signed).to.have.length(1);
    expect(signed[0].recipient).to.equal(base.action.recipient);
  });

  it("without a gather, a microtask queued during mapping: ALLOW_UNDER_POLICY, and the signer gets the JSON data taken before the microtask ran", async () => {
    const req = makeRequest();
    const originalRecipient = req.action.recipient;
    const originalAmount = req.action.amount;
    const signed: ConsultAction[] = [];
    const result = await runTriggerGuard(
      baseInput({
        payment: req,
        toRequest: (p) => {
          queueMicrotask(() => {
            const a = p.action as unknown as Record<string, unknown>;
            a.recipient = UNAPPROVED_RECIPIENT;
            a.amount = "999999999999";
          });
          return p;
        },
        signer: (a) => {
          signed.push({ ...a });
          return "SIGNED";
        },
      })
    );
    expect(result.consult.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(signed[0].recipient).to.equal(originalRecipient);
    expect(signed[0].amount).to.equal(originalAmount);
  });

  it("with a gather, a microtask queued during mapping that swaps in an approved recipient: DENY, and the signer is never called", async () => {
    const base = makeRequest();
    const approved = base.action.recipient;
    const req: ConsultRequest = {
      ...base,
      action: { ...base.action, recipient: UNAPPROVED_RECIPIENT },
    };
    const gathered: unknown[] = [];
    let signerCalls = 0;
    const result = await runTriggerGuard(
      baseInput({
        payment: req,
        toRequest: (p) => {
          queueMicrotask(() => {
            (p.action as unknown as Record<string, unknown>).recipient =
              approved;
          });
          return p;
        },
        gather: (snapshot) => {
          gathered.push(snapshot);
          return undefined;
        },
        signer: () => {
          signerCalls += 1;
          return "SIGNED";
        },
      })
    );
    expect(result.consult.verdict).to.equal("DENY");
    expect(result.signerOutcome).to.equal("not-attempted");
    expect(signerCalls).to.equal(0);
    expect(gathered).to.have.length(1);
    const seen = gathered[0] as ConsultRequest;
    expect(seen).to.not.equal(req);
    expect(Object.isFrozen(seen)).to.equal(true);
    expect(Object.isFrozen(seen.action)).to.equal(true);
    expect(seen.action.recipient).to.equal(UNAPPROVED_RECIPIENT);
  });

  it("with a gather, a 1 ms timer queued during mapping that swaps in an approved recipient: DENY, and the signer is never called", async () => {
    const base = makeRequest();
    const approved = base.action.recipient;
    const req: ConsultRequest = {
      ...base,
      action: { ...base.action, recipient: UNAPPROVED_RECIPIENT },
    };
    const gathered: unknown[] = [];
    let signerCalls = 0;
    const result = await runTriggerGuard(
      baseInput({
        payment: req,
        toRequest: (p) => {
          setTimeout(() => {
            (p.action as unknown as Record<string, unknown>).recipient =
              approved;
          }, 1);
          return p;
        },
        gather: async (snapshot) => {
          gathered.push(snapshot);
          await sleep(20);
          return undefined;
        },
        signer: () => {
          signerCalls += 1;
          return "SIGNED";
        },
      })
    );
    expect(req.action.recipient).to.equal(approved);
    expect(result.consult.verdict).to.equal("DENY");
    expect(result.signerOutcome).to.equal("not-attempted");
    expect(signerCalls).to.equal(0);
    expect(gathered).to.have.length(1);
    const seen = gathered[0] as ConsultRequest;
    expect(seen).to.not.equal(req);
    expect(Object.isFrozen(seen.action)).to.equal(true);
    expect(seen.action.recipient).to.equal(UNAPPROVED_RECIPIENT);
  });

  it("a concurrent mutation while an async signer awaits cannot change what gets signed", async () => {
    const req = makeRequest();
    const originalRecipient = req.action.recipient;
    const originalAmount = req.action.amount;
    const signed: ConsultAction[] = [];
    setTimeout(() => {
      const a = req.action as unknown as Record<string, unknown>;
      a.recipient = UNAPPROVED_RECIPIENT;
      a.amount = "999999999999";
    }, 5);
    const result = await runTriggerGuard(
      baseInput({
        payment: req,
        toRequest: (p) => p,
        signer: async (a) => {
          await sleep(20);
          signed.push({ ...a });
          return "SIGNED";
        },
      })
    );
    expect(result.consult.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(signed[0].recipient).to.equal(originalRecipient);
    expect(signed[0].amount).to.equal(originalAmount);
  });

  it("a synchronous gather that overruns its deadline fails closed and never calls the signer", async () => {
    let signerCalls = 0;
    const result = await runTriggerGuard(
      baseInput({
        gather: () => {
          const start = Date.now();
          while (Date.now() - start < 120) {
            /* busy: simulates a synchronous overrun */
          }
          return {};
        },
        gatherDeadlineMs: 5,
        signer: () => {
          signerCalls += 1;
          return "SIGNED";
        },
      })
    );
    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.results[0].code).to.equal("GUARD_GATHER_TIMED_OUT");
    expect(signerCalls).to.equal(0);
  });

  it("the guard's own UNKNOWN result truncates evidence and is deep-frozen", async () => {
    const result = await runTriggerGuard(
      baseInput({
        toRequest: () => {
          throw new Error("A".repeat(5_000_000));
        },
      })
    );
    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.results[0].evidence.length).to.be.lessThan(5_000_000);
    expect(Object.isFrozen(result.consult)).to.equal(true);
    expect(Object.isFrozen(result.consult.results[0])).to.equal(true);
    expect(Object.isFrozen(result.consult.results)).to.equal(true);
  });

  it("a thrown null-prototype value comes back UNKNOWN, never a rejection", async () => {
    const result = await runTriggerGuard(
      baseInput({
        toRequest: () => {
          throw Object.create(null);
        },
      })
    );
    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.results[0].code).to.equal("GUARD_MAPPING_FAILED");
  });

  it("a thrown Error with a non-string message comes back UNKNOWN, never a rejection", async () => {
    const error = new Error("original");
    Object.defineProperty(error, "message", { value: 42 });
    const result = await runTriggerGuard(
      baseInput({
        gather: () => {
          throw error;
        },
      })
    );
    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.results[0].code).to.equal("GUARD_GATHER_FAILED");
    expect(typeof result.consult.results[0].evidence).to.equal("string");
  });

  it("a revoked Proxy thrown from toRequest comes back UNKNOWN, never a rejection", async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const result = await runTriggerGuard(
      baseInput({
        toRequest: () => {
          throw proxy;
        },
      })
    );
    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.results[0].code).to.equal("GUARD_MAPPING_FAILED");
  });

  it("a getPrototypeOf trap that throws comes back UNKNOWN, never a rejection", async () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("trap");
        },
      }
    );
    const result = await runTriggerGuard(
      baseInput({
        gather: () => {
          throw hostile;
        },
      })
    );
    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.results[0].code).to.equal("GUARD_GATHER_FAILED");
  });

  it("a message getter that throws comes back UNKNOWN, never a rejection", async () => {
    const error = new Error("x");
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("boom");
      },
    });
    const result = await runTriggerGuard(
      baseInput({
        toRequest: () => {
          throw error;
        },
      })
    );
    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.results[0].code).to.equal("GUARD_MAPPING_FAILED");
  });

  it("a message getter that flips from a string to an object never throws when read", async () => {
    const error = new Error("x");
    let reads = 0;
    Object.defineProperty(error, "message", {
      get() {
        reads += 1;
        return reads === 1 ? "ok" : { not: "a string" };
      },
    });
    const result = await runTriggerGuard(
      baseInput({
        toRequest: () => {
          throw error;
        },
      })
    );
    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(typeof result.consult.results[0].evidence).to.equal("string");
  });

  it("a NaN gatherDeadlineMs fails closed instead of disabling the deadline", async () => {
    let signerCalls = 0;
    const result = await runTriggerGuard(
      baseInput({
        gather: () => {
          const start = performance.now();
          while (performance.now() - start < 60) {
            /* busy */
          }
          return {};
        },
        gatherDeadlineMs: NaN,
        signer: () => {
          signerCalls += 1;
          return "SIGNED";
        },
      })
    );
    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.results[0].code).to.equal(
      "GUARD_GATHER_DEADLINE_INVALID"
    );
    expect(signerCalls).to.equal(0);
  });

  it("zero, negative-zero, sub-millisecond, Infinity, negative, and over-ceiling deadlines all fail closed", async () => {
    for (const bad of [
      0,
      -0,
      Number.MIN_VALUE,
      1e-3,
      0.5,
      Infinity,
      -1,
      2147483648,
    ]) {
      const result = await runTriggerGuard(
        baseInput({
          gatherDeadlineMs: bad,
          gather: () => ({}),
        })
      );
      expect(result.consult.verdict).to.equal("UNKNOWN");
      expect(result.consult.results[0].code).to.equal(
        "GUARD_GATHER_DEADLINE_INVALID"
      );

      let signerCalls = 0;
      const signerResult = await runTriggerGuard(
        baseInput({
          signerDeadlineMs: bad,
          signer: () => {
            signerCalls += 1;
            return "SIGNED";
          },
        })
      );
      expect(signerResult.consult.verdict).to.equal("UNKNOWN");
      expect(signerResult.consult.results[0].code).to.equal(
        "GUARD_SIGNER_DEADLINE_INVALID"
      );
      expect(signerResult.signerOutcome).to.equal("not-attempted");
      expect(signerCalls).to.equal(0);
    }
  });

  it("an invalid signerDeadlineMs fails closed before gather or consult() ever run", async () => {
    let gatherCalls = 0;
    let consultCalls = 0;
    let signerCalls = 0;
    const countingConsult: ConsultFn = () => {
      consultCalls += 1;
      return {
        question: "counting",
        proceed: true,
        verdict: "ALLOW_UNDER_POLICY",
        support: 1,
        band: "green",
        results: [],
        floorIds: [],
        advisory: true,
      };
    };
    const result = await runTriggerGuardWith(
      countingConsult,
      baseInput({
        gather: () => {
          gatherCalls += 1;
          return {};
        },
        signerDeadlineMs: 0,
        signer: () => {
          signerCalls += 1;
          return "SIGNED";
        },
      })
    );
    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.results[0].code).to.equal(
      "GUARD_SIGNER_DEADLINE_INVALID"
    );
    expect(gatherCalls).to.equal(0);
    expect(consultCalls).to.equal(0);
    expect(signerCalls).to.equal(0);
  });

  it("an action with no own recipient, while Object.prototype.recipient is set: the signer reads recipient as undefined", async () => {
    const base = makeRequest();
    const approved = base.action.recipient as string;
    const action = { ...base.action } as Record<string, unknown>;
    delete action.recipient;
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto.recipient = approved;
    let seenBySigner: unknown;
    try {
      setTimeout(() => {
        proto.recipient = UNAPPROVED_RECIPIENT;
      }, 5);
      const result = await runTriggerGuard(
        baseInput({
          payment: { action } as unknown as ConsultRequest,
          toRequest: (p) => p,
          signer: async (a) => {
            await sleep(20);
            seenBySigner = (a as unknown as Record<string, unknown>).recipient;
            return "SIGNED";
          },
        })
      );
      expect(result.signerOutcome).to.equal("settled");
      expect(seenBySigner).to.equal(undefined);
    } finally {
      delete proto.recipient;
    }
  });

  it("a BigInt, a cycle, a throwing getter or a throwing toJSON in the mapped request (no patched built-ins) comes back UNKNOWN GUARD_MAPPING_FAILED, with gather and the signer never called", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cases: [string, unknown][] = [
      ["BigInt", 1n],
      ["cycle", cyclic],
      [
        "throwing getter",
        Object.defineProperty({}, "x", {
          enumerable: true,
          get() {
            throw new Error("getter");
          },
        }),
      ],
      [
        "throwing toJSON",
        {
          toJSON() {
            throw new Error("toJSON");
          },
        },
      ],
    ];
    for (const [label, extra] of cases) {
      const base = makeRequest();
      let gatherCalls = 0;
      let signerCalls = 0;
      const result = await runTriggerGuard(
        baseInput({
          toRequest: () =>
            ({
              ...base,
              action: { ...base.action, extra },
            } as unknown as ConsultRequest),
          gather: () => {
            gatherCalls += 1;
            return undefined;
          },
          signer: () => {
            signerCalls += 1;
            return "SIGNED";
          },
        })
      );
      expect(result.consult.verdict, label).to.equal("UNKNOWN");
      expect(result.consult.results[0].code, label).to.equal(
        "GUARD_MAPPING_FAILED"
      );
      expect(gatherCalls, label).to.equal(0);
      expect(signerCalls, label).to.equal(0);
    }
  });

  it("a request of shared references that JSON would expand past the size limit comes back UNKNOWN quickly, with gather and the signer never called", async () => {
    const base = makeRequest();
    let node: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i += 1) node = { l: node, r: node };
    let gatherCalls = 0;
    let signerCalls = 0;
    const start = performance.now();
    const result = await runTriggerGuard(
      baseInput({
        toRequest: () =>
          ({
            ...base,
            action: { ...base.action, extra: node },
          } as unknown as ConsultRequest),
        gather: () => {
          gatherCalls += 1;
          return undefined;
        },
        signer: () => {
          signerCalls += 1;
          return "SIGNED";
        },
      })
    );
    expect(performance.now() - start).to.be.below(500);
    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.results[0].code).to.equal("GUARD_MAPPING_FAILED");
    expect(gatherCalls).to.equal(0);
    expect(signerCalls).to.equal(0);
  });

  for (const [label, extra, evidence] of [
    [
      "long strings in few values",
      Array(20).fill("a".repeat(100_000)),
      "passed the size limit while being written",
    ],
    [
      "an array-only DAG of depth 40 over a number",
      (() => {
        let node: unknown = 1;
        for (let i = 0; i < 40; i += 1) node = [node, node];
        return node;
      })(),
      "passed the size limit while being written",
    ],
    [
      "long record keys",
      Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [String(i).padEnd(5_000, "k"), 1])
      ),
      "passed the size limit while being written",
    ],
    [
      "a string JSON escapes to twice its length",
      '"'.repeat(40_000),
      "JSON exceeds the size limit",
    ],
  ] as const) {
    it(`a request whose JSON exceeds the size limit (${label}) comes back UNKNOWN GUARD_MAPPING_FAILED quickly, with gather and the signer never called`, async () => {
      const base = makeRequest();
      let gatherCalls = 0;
      let signerCalls = 0;
      const start = performance.now();
      const result = await runTriggerGuard(
        baseInput({
          toRequest: () =>
            ({
              ...base,
              action: { ...base.action, extra },
            } as unknown as ConsultRequest),
          gather: () => {
            gatherCalls += 1;
            return undefined;
          },
          signer: () => {
            signerCalls += 1;
            return "SIGNED";
          },
        })
      );
      expect(performance.now() - start).to.be.below(500);
      expect(result.consult.verdict).to.equal("UNKNOWN");
      expect(result.consult.results[0].code).to.equal("GUARD_MAPPING_FAILED");
      expect(result.consult.results[0].evidence).to.contain(evidence);
      expect(gatherCalls).to.equal(0);
      expect(signerCalls).to.equal(0);
    });
  }

  it("a request with no JSON form (a prototype toJSON that returns undefined) comes back UNKNOWN GUARD_MAPPING_FAILED, with gather and the signer never called", async () => {
    let gatherCalls = 0;
    let signerCalls = 0;
    const result = await runTriggerGuard(
      baseInput({
        toRequest: () =>
          Object.assign(
            Object.create({
              toJSON() {
                return undefined;
              },
            }),
            makeRequest()
          ) as ConsultRequest,
        gather: () => {
          gatherCalls += 1;
          return undefined;
        },
        signer: () => {
          signerCalls += 1;
          return "SIGNED";
        },
      })
    );
    expect(result.consult.verdict).to.equal("UNKNOWN");
    expect(result.consult.results[0].code).to.equal("GUARD_MAPPING_FAILED");
    expect(gatherCalls).to.equal(0);
    expect(signerCalls).to.equal(0);
  });

  it("a Map in a named array property, rewritten by a gather timer: gather receives the frozen snapshot and the signer receives its action field, with no Map in it", async () => {
    const base = makeRequest();
    const meta = new Map([["to", "orig"]]);
    const extra = Object.assign([], { meta });
    const gathered: ConsultRequest[] = [];
    const signed: ConsultAction[] = [];
    const result = await runTriggerGuard(
      baseInput({
        toRequest: () =>
          ({
            ...base,
            action: { ...base.action, extra },
          } as unknown as ConsultRequest),
        gather: (snapshot) => {
          gathered.push(snapshot);
          setTimeout(() => meta.set("to", UNAPPROVED_RECIPIENT), 5);
          return undefined;
        },
        signer: async (a) => {
          await sleep(20);
          signed.push(a);
          return "SIGNED";
        },
      })
    );
    expect(result.consult.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(signed).to.have.length(1);
    expect(signed[0]).to.equal(gathered[0].action);
    expectSnapshotData(signed[0]);
    const signedExtra = (signed[0] as unknown as Record<string, unknown>)
      .extra as unknown[];
    expect(signedExtra).to.deep.equal([]);
    expect(Object.hasOwn(signedExtra, "meta")).to.equal(false);
  });

  it("a SharedArrayBuffer in the request: the signer receives the action field of the frozen snapshot passed to consult(), which shares no memory with the caller's buffer", async () => {
    const base = makeRequest();
    const shared = new SharedArrayBuffer(4);
    const signed: ConsultAction[] = [];
    const result = await runTriggerGuard(
      baseInput({
        toRequest: () =>
          ({
            ...base,
            action: {
              ...base.action,
              buf: shared,
              extra: Object.assign([], { buf: shared }),
            },
          } as unknown as ConsultRequest),
        signer: (a) => {
          signed.push(a);
          return "SIGNED";
        },
      })
    );
    expect(result.consult.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(signed).to.have.length(1);
    expectSnapshotData(signed[0]);
    const a = signed[0] as unknown as Record<string, unknown>;
    expect(a.buf).to.deep.equal({});
    expect(a.extra).to.deep.equal([]);
  });

  it("non-JSON values reach gather and the signer as whatever JSON.stringify writes for them", async () => {
    const base = makeRequest();
    const when = new Date(0);
    const meta = new Map([["to", "orig"]]);
    const gathered: ConsultRequest[] = [];
    const signed: ConsultAction[] = [];
    const result = await runTriggerGuard(
      baseInput({
        toRequest: () =>
          ({
            ...base,
            action: {
              ...base.action,
              when,
              meta,
              extra: [
                new Set(["orig"]),
                new ArrayBuffer(4),
                new Uint8Array(2),
                new DataView(new ArrayBuffer(4)),
                /orig/,
                new String("orig"),
                undefined,
              ],
              fn: () => 1,
            },
          } as unknown as ConsultRequest),
        gather: (snapshot) => {
          gathered.push(snapshot);
          setTimeout(() => {
            when.setTime(1);
            meta.set("to", UNAPPROVED_RECIPIENT);
          }, 5);
          return undefined;
        },
        signer: async (a) => {
          await sleep(20);
          signed.push(a);
          return "SIGNED";
        },
      })
    );
    expect(result.consult.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(signed).to.have.length(1);
    expectSnapshotData(signed[0]);
    const a = signed[0] as unknown as Record<string, unknown>;
    expect(a.when).to.equal("1970-01-01T00:00:00.000Z");
    expect(a.meta).to.deep.equal({});
    expect(a.extra).to.deep.equal([
      {},
      {},
      { 0: 0, 1: 0 },
      {},
      {},
      "orig",
      null,
    ]);
    expect(Object.hasOwn(a, "fn")).to.equal(false);
    expect(gathered).to.have.length(1);
    expectSnapshotData(gathered[0]);
    expect(gathered[0].action).to.deep.equal(signed[0]);
  });

  it("a non-number deadline whose String() throws comes back UNKNOWN, never a rejection", async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const hostile: [string, unknown][] = [
      ["null-prototype object", Object.create(null)],
      [
        "throwing toString",
        {
          toString() {
            throw new Error("t");
          },
        },
      ],
      ["revoked Proxy", proxy],
    ];
    for (const [label, bad] of hostile) {
      let gatherCalls = 0;
      const gathered = await runTriggerGuard(
        baseInput({
          gatherDeadlineMs: bad as number,
          gather: () => {
            gatherCalls += 1;
            return {};
          },
        })
      ).catch((error: unknown) => `rejected (${label}): ${String(error)}`);
      expect(gathered, label).to.not.be.a("string");
      if (typeof gathered === "string") continue;
      expect(gathered.consult.verdict, label).to.equal("UNKNOWN");
      expect(gathered.consult.results[0].code, label).to.equal(
        "GUARD_GATHER_DEADLINE_INVALID"
      );
      expect(gathered.consult.results[0].evidence, label).to.contain(
        "gatherDeadlineMs object"
      );
      expect(gatherCalls, label).to.equal(0);

      let signerCalls = 0;
      const signed = await runTriggerGuard(
        baseInput({
          signerDeadlineMs: bad as number,
          signer: () => {
            signerCalls += 1;
            return "SIGNED";
          },
        })
      ).catch((error: unknown) => `rejected (${label}): ${String(error)}`);
      expect(signed, label).to.not.be.a("string");
      if (typeof signed === "string") continue;
      expect(signed.consult.results[0].code, label).to.equal(
        "GUARD_SIGNER_DEADLINE_INVALID"
      );
      expect(signed.signerOutcome, label).to.equal("not-attempted");
      expect(signerCalls, label).to.equal(0);
    }
  });

  it("the verdict comes from consult(): a caller-attached proceed/verdict never changes the outcome", async () => {
    const request = makeRequest({
      action: { ...makeRequest().action, recipient: UNAPPROVED_RECIPIENT },
    });
    let signerCalls = 0;
    const spoofed = {
      ...baseInput({
        payment: request,
        toRequest: (payment: ConsultRequest) => payment,
        signer: () => {
          signerCalls += 1;
          return "SIGNED";
        },
      }),
      verdict: "ALLOW_UNDER_POLICY",
      proceed: true,
      result: { verdict: "ALLOW_UNDER_POLICY", proceed: true },
    };

    const result = await runTriggerGuard(
      spoofed as unknown as TriggerGuardInput<ConsultRequest, string>
    );

    expect(result.consult.verdict).to.equal("DENY");
    expect(result.signerOutcome).to.equal("not-attempted");
    expect(signerCalls).to.equal(0);
  });
});

// Never called: it compiles only while ConsultResponse still has an
// advisory field. TriggerGuardResult.consult's own ConsultResponse type is
// what keeps the guard from handing back a bespoke shape.
function assertShape(response: ConsultResponse): void {
  expect(response.advisory).to.equal(true);
}
void assertShape;
