import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import { consult } from "../src";
import type { Catalog, ConditionContext } from "../src/catalog";
import { consultWith } from "../src/internal";
import {
  PARAM_READS,
  checkParam,
  paramReadViolations,
  paramReader,
} from "../src/params";
import {
  makePolicy,
  makeRequest,
  makeSwapFacts,
  makeSwapPolicy,
  makeSwapRequest,
  testCondition,
} from "./fixtures";

const ID = "fixture-params-alpha";
const BUNDLE = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "params-bundle.json"), "utf8")
);

// The fixture bundle with every value replaced by a sentinel naming its key,
// so a sweep can tell which constants a Condition could reach.
function sentinelBundle(): Record<
  string,
  Record<string, Record<string, unknown>>
> {
  const copy = JSON.parse(JSON.stringify(BUNDLE));
  for (const key of Object.keys(copy[ID])) {
    copy[ID][key].value = `sentinel-${key}`;
  }
  return copy;
}

const READS: readonly (readonly [string, string])[] = [
  [ID, "fixture_check_a"],
  [ID, "fixture_next_e"],
];

const INTRINSIC_PROTOTYPES = new Set<unknown>([
  null,
  Object.prototype,
  Array.prototype,
  Function.prototype,
]);

// Every value reachable from `root` through own properties, without calling
// a getter. Prototypes are recorded, not walked.
function sweep(root: unknown): { strings: Set<string>; protos: Set<unknown> } {
  const strings = new Set<string>();
  const protos = new Set<unknown>();
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      strings.add(value);
      return;
    }
    if (
      (typeof value !== "object" && typeof value !== "function") ||
      value === null ||
      seen.has(value)
    ) {
      return;
    }
    seen.add(value);
    protos.add(Object.getPrototypeOf(value));
    for (const key of Reflect.ownKeys(value)) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc !== undefined && "value" in desc) {
        visit(desc.value);
      }
    }
  };
  visit(root);
  return { strings, protos };
}

interface Observed {
  contextKeys: string[];
  factsKeys: string[];
  factsFrozen: boolean;
  constantFrozen: boolean;
  sentinels: string[];
  protosIntrinsic: boolean;
  probes: Record<string, unknown>;
}

function probeCatalog(record: (o: Observed) => void): Catalog {
  return {
    pay: [
      testCondition({
        id: "params-probe",
        isFloor: true,
        check: (request, context: ConditionContext) => {
          /* eslint-disable @typescript-eslint/no-explicit-any */
          const facts = context.facts as any;
          const reads = [
            context.param(ID, "fixture_check_a"),
            context.param(ID, "fixture_next_e"),
            context.param(ID, "fixture_both_b"),
            context.param(ID, "toString"),
            context.param(ID, "__proto__"),
            context.param("constructor", "fixture_check_a"),
          ];
          const probes: Record<string, unknown> = {
            "facts.params": facts?.params,
            "context.params": (context as any).params,
            "Reflect.get": Reflect.get(Object(context.facts), "params"),
            "logical assignment alias": (() => {
              let f: any;
              f ??= context.facts;
              return f?.params;
            })(),
            "throw and catch": (() => {
              try {
                throw context.facts;
              } catch (e: any) {
                return e?.params;
              }
            })(),
            valueOf: facts?.valueOf().params,
            "class extends": (() => {
              class X extends (facts?.params ?? Object) {}
              const base = Object.getPrototypeOf(X);
              return base === Object ? undefined : base;
            })(),
            "fake gate": (() => {
              const o = { checkParam: (p: unknown) => p };
              return o.checkParam(facts?.params);
            })(),
            "real checkParam on facts": checkParam(
              facts,
              ID,
              "fixture_check_a"
            ),
            "real checkParam on facts.params": checkParam(
              facts?.params,
              ID,
              "fixture_check_a"
            ),
          };
          const reached = sweep([request, context, reads, probes]);
          record({
            contextKeys: Object.keys(context).sort(),
            factsKeys:
              facts !== null && typeof facts === "object"
                ? Object.keys(facts).sort()
                : [],
            factsFrozen: Object.isFrozen(context.facts),
            constantFrozen:
              Object.isFrozen(reads[0]) && Object.isFrozen(reads[0]?.scrub),
            sentinels: [...reached.strings]
              .filter((s) => s.startsWith("sentinel-"))
              .sort(),
            protosIntrinsic: [...reached.protos].every((p) =>
              INTRINSIC_PROTOTYPES.has(p)
            ),
            probes,
          });
          return reads[0]?.value === "sentinel-fixture_check_a"
            ? {
                id: "params-probe",
                status: "PASS",
                code: "TEST_PASS",
                evidenceClass: "owner-policy",
                evidence: "read the listed check constant",
              }
            : {
                id: "params-probe",
                status: "UNVERIFIED",
                code: "TEST_UNVERIFIED",
                evidenceClass: "not-verifiable",
                evidence: "no constant",
              };
        },
      }),
    ],
  };
}

function run(
  facts: unknown,
  reads?: readonly (readonly [string, string])[]
): { observed: Observed; code: string } {
  let observed: Observed | undefined;
  const response = consultWith(
    probeCatalog((o) => (observed = o)),
    undefined,
    reads
  )(makeRequest(), makePolicy(), facts);
  if (observed === undefined) throw new Error("probe did not run");
  return { observed, code: response.results[0].code };
}

describe("params channel: a Condition reads params only through context.param", () => {
  const facts = () => ({
    now: 1,
    extra: { note: "kept" },
    params: sentinelBundle(),
  });

  it("hands a Condition a listed check constant through context.param", () => {
    expect(run(facts(), READS).code).to.equal("TEST_PASS");
  });

  it("returns nothing for the listed constant when facts carry no params", () => {
    expect(run({ now: 1 }, READS).code).to.equal("TEST_UNVERIFIED");
  });

  it("returns nothing for an unlisted constant under the real list", () => {
    expect(run(facts()).code).to.equal("TEST_UNVERIFIED");
  });

  it("gives a Condition exactly policy, facts and param, and facts without params", () => {
    const { observed } = run(facts(), READS);
    expect(observed.contextKeys).to.deep.equal(["facts", "param", "policy"]);
    expect(observed.factsKeys).to.deep.equal(["extra", "now"]);
    expect(observed.factsFrozen).to.equal(true);
    expect(observed.constantFrozen).to.equal(true);
  });

  it("reaches no constant but the listed check one, from any value a Condition holds", () => {
    const { observed } = run(facts(), READS);
    expect(observed.sentinels).to.deep.equal(["sentinel-fixture_check_a"]);
    expect(observed.protosIntrinsic).to.equal(true);
  });

  it("every round-4 read form finds no params", () => {
    const { observed } = run(facts(), READS);
    for (const [name, value] of Object.entries(observed.probes)) {
      expect(value, name).to.equal(undefined);
    }
  });

  it("leaves every verdict unchanged when facts carry params", () => {
    const withParams = consult(makeSwapRequest(), makeSwapPolicy(), {
      ...makeSwapFacts(),
      params: BUNDLE,
    });
    const without = consult(
      makeSwapRequest(),
      makeSwapPolicy(),
      makeSwapFacts()
    );
    expect(withParams).to.deep.equal(without);
  });
});

describe("params channel: paramReader and the used-by check", () => {
  it("paramReader returns a listed check or both constant, and nothing else", () => {
    const read = paramReader(BUNDLE, [
      [ID, "fixture_check_a"],
      [ID, "fixture_both_b"],
      [ID, "fixture_next_e"],
    ]);
    expect(read(ID, "fixture_check_a")?.used_by).to.equal("check");
    expect(read(ID, "fixture_both_b")?.used_by).to.equal("both");
    expect(read(ID, "fixture_next_e")).to.equal(undefined);
    expect(paramReader(BUNDLE, [])(ID, "fixture_check_a")).to.equal(undefined);
    expect(paramReader(undefined, READS)(ID, "fixture_check_a")).to.equal(
      undefined
    );
  });

  it("PARAM_READS cannot be changed at run time", () => {
    expect(Object.isFrozen(PARAM_READS)).to.equal(true);
    expect(PARAM_READS.every((pair) => Object.isFrozen(pair))).to.equal(true);
  });

  it("the used-by check passes check and both reads", () => {
    expect(
      paramReadViolations(
        [
          [ID, "fixture_check_a"],
          [ID, "fixture_both_b"],
        ],
        BUNDLE
      )
    ).to.deep.equal([]);
  });

  for (const key of [
    "fixture_other_c",
    "fixture_unassigned_d",
    "fixture_next_e",
  ]) {
    it(`the used-by check fails on a listed ${key}`, () => {
      const problems = paramReadViolations([[ID, key]], BUNDLE);
      expect(problems).to.have.length(1);
      expect(problems[0]).to.include(key);
    });
  }

  it("the used-by check fails on a pair the bundle does not hold, and on a bad bundle", () => {
    expect(
      paramReadViolations([[ID, "fixture_missing"]], BUNDLE)
    ).to.have.length(1);
    expect(paramReadViolations([[ID, "toString"]], BUNDLE)).to.have.length(1);
    expect(
      paramReadViolations([[ID, "fixture_check_a"]], { broken: 1 })
    ).to.have.length(1);
  });

  it("checkParam, paramReader and the used-by check allow the same labels", () => {
    const key = "fixture_check_a";
    for (const label of [
      "check",
      "both",
      "next",
      "review",
      "check_or_review",
      "other",
    ]) {
      const bundle = {
        [ID]: { [key]: { ...BUNDLE[ID][key], used_by: label } },
      };
      const runtime = checkParam(bundle, ID, key) !== undefined;
      expect(
        paramReader(bundle, [[ID, key]])(ID, key) !== undefined,
        label
      ).to.equal(runtime);
      expect(
        paramReadViolations([[ID, key]], bundle).length === 0,
        label
      ).to.equal(runtime);
    }
  });
});
