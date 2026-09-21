import { expect } from "chai";

import { consult } from "../src";
import {
  ROLE_CLUSTER,
  ROLE_HOLDER,
  ROLE_MAX_AGE_SECONDS,
  ROLE_MEMBER,
  ROLE_NAME,
  ROLE_PROGRAM_ID,
  SWAP_NOW,
  makeGoodRoleFact,
  makePolicy,
  makeRequest,
  makeRequiredRolePolicy,
  makeSwapFacts,
  makeSwapPolicy,
  makeSwapRequest,
} from "./fixtures";

// A base58, well-formed, but different holder than ROLE_HOLDER: same shape,
// a genuinely different key.
const ROLE_OTHER_HOLDER = "HwAtHderSeed9ABJKmnpqHwAtHderSee";

const GOOD_PROVENANCE = {
  source: "test-fixture",
  slot: 1,
  commitment: "confirmed",
  observedAt: SWAP_NOW,
};

function makeSubjectOverride(
  subjectOverrides: Record<string, unknown>
): Record<string, unknown> {
  return {
    subject: {
      cluster: ROLE_CLUSTER,
      programId: ROLE_PROGRAM_ID,
      role: ROLE_NAME,
      holder: ROLE_HOLDER,
      ...subjectOverrides,
    },
  };
}

interface ActionFixture {
  name: string;
  codePrefix: string;
  run: (role: unknown, facts?: unknown) => ReturnType<typeof consult>;
}

// One shared checker, two action types: every test below runs once per
// action, proving the same rules hold under pay's own Floor and swap's own
// Floor rather than only one of them.
const ACTIONS: ActionFixture[] = [
  {
    name: "pay",
    codePrefix: "",
    run: (role, facts) =>
      consult(
        makeRequest(),
        makePolicy({ role: role as never }),
        facts as never
      ),
  },
  {
    name: "swap",
    codePrefix: "SWAP_",
    run: (role, facts) =>
      consult(
        makeSwapRequest(),
        makeSwapPolicy({ role: role as never }),
        facts !== undefined ? (facts as never) : (makeSwapFacts() as never)
      ),
  },
];

function roleRow(response: ReturnType<typeof consult>) {
  return response.results.find((r) => r.id === "role-requirement-met");
}

describe("role-requirement-met", () => {
  ACTIONS.forEach(({ name, codePrefix, run }) => {
    describe(`${name}`, () => {
      const code = (suffix: string): string => `${codePrefix}${suffix}`;
      const goodRole = () => makeRequiredRolePolicy();
      const goodFacts = () => ({
        now: SWAP_NOW,
        solanaRole: makeGoodRoleFact(),
      });

      it("mode not-required passes without looking at any fact", () => {
        const response = run({ mode: "not-required" });
        const row = roleRow(response);
        expect(row?.status).to.equal("PASS");
        expect(row?.code).to.equal(code("ROLE_NOT_REQUIRED"));
        expect(row?.evidenceClass).to.equal("owner-policy");
      });

      it("mode not-required passes even with a valid:false fact present, and proceed is unchanged", () => {
        const withoutFact = run({ mode: "not-required" });
        const withFact = run(
          { mode: "not-required" },
          {
            now: SWAP_NOW,
            solanaRole: makeGoodRoleFact({
              valid: false,
              reason: "RoleDisabled",
            }),
          }
        );
        expect(roleRow(withFact)?.status).to.equal("PASS");
        expect(roleRow(withFact)?.code).to.equal(code("ROLE_NOT_REQUIRED"));
        expect(withFact.proceed).to.equal(withoutFact.proceed);
        expect(withFact.verdict).to.equal(withoutFact.verdict);
      });

      it("a well-formed required policy plus a good fact earns ROLE_HELD, class onchain-read", () => {
        const response = run(goodRole(), goodFacts());
        const row = roleRow(response);
        expect(row?.status).to.equal("PASS");
        expect(row?.code).to.equal(code("ROLE_HELD"));
        expect(row?.evidenceClass).to.equal("onchain-read");
        expect(response.proceed).to.equal(true);
      });

      (
        [
          undefined,
          null,
          "required",
          [],
          {},
          { mode: "Required" },
          { mode: "REQUIRED" },
          { mode: " required" },
          { mode: true },
          // eslint-disable-next-line no-new-wrappers
          { mode: new String("required") },
        ] as unknown[]
      ).forEach((role) => {
        it(`policy role ${JSON.stringify(
          role
        )} is UNVERIFIED with ROLE_POLICY_MISSING`, () => {
          const response = run(role);
          const row = roleRow(response);
          expect(row?.status).to.equal("UNVERIFIED");
          expect(row?.code).to.equal(code("ROLE_POLICY_MISSING"));
          expect(response.proceed).to.equal(false);
        });
      });

      const REQUIRED_FIELD_MUTATIONS: Array<[string, Record<string, unknown>]> =
        [
          ["cluster missing", { cluster: undefined }],
          ["cluster unknown", { cluster: "devnetx" }],
          ["programId too short", { programId: "short" }],
          [
            "programId has a zero",
            { programId: `0${ROLE_PROGRAM_ID.slice(1)}` },
          ],
          ["role empty", { role: "" }],
          ["holder not a string", { holder: 1234 }],
          ["maxAgeSeconds zero", { maxAgeSeconds: 0 }],
          ["maxAgeSeconds over ceiling", { maxAgeSeconds: 61 }],
          ["maxAgeSeconds a float", { maxAgeSeconds: 1.5 }],
          ["maxAgeSeconds a string", { maxAgeSeconds: "30" }],
          ["maxAgeSeconds NaN", { maxAgeSeconds: Number.NaN }],
          ["maxAgeSeconds huge", { maxAgeSeconds: 1e300 }],
        ];
      REQUIRED_FIELD_MUTATIONS.forEach(([label, overrides]) => {
        it(`required policy: ${label} is UNVERIFIED with ROLE_POLICY_MALFORMED`, () => {
          const response = run(makeRequiredRolePolicy(overrides));
          const row = roleRow(response);
          expect(row?.status, label).to.equal("UNVERIFIED");
          expect(row?.code, label).to.equal(code("ROLE_POLICY_MALFORMED"));
        });
      });

      describe("member (optional)", () => {
        it("a good fact still earns ROLE_HELD when member is present and well-formed", () => {
          const response = run(
            makeRequiredRolePolicy({ member: ROLE_MEMBER }),
            goodFacts()
          );
          const row = roleRow(response);
          expect(row?.status).to.equal("PASS");
          expect(row?.code).to.equal(code("ROLE_HELD"));
        });

        (
          [
            ["too short", "short"],
            ["contains a zero", `0${ROLE_MEMBER.slice(1)}`],
            ["contains an uppercase O", `O${ROLE_MEMBER.slice(1)}`],
            ["contains an uppercase I", `I${ROLE_MEMBER.slice(1)}`],
            ["contains a lowercase l", `l${ROLE_MEMBER.slice(1)}`],
            ["a number", 12345],
            ["an empty string", ""],
          ] as Array<[string, unknown]>
        ).forEach(([label, member]) => {
          it(`member ${label} is ROLE_POLICY_MALFORMED`, () => {
            const response = run(
              makeRequiredRolePolicy({ member }),
              goodFacts()
            );
            const row = roleRow(response);
            expect(row?.status, label).to.equal("UNVERIFIED");
            expect(row?.code, label).to.equal(code("ROLE_POLICY_MALFORMED"));
          });
        });

        it("changing member alone between two otherwise identical good runs does not change the result", () => {
          const withoutMember = run(makeRequiredRolePolicy(), goodFacts());
          const withMember = run(
            makeRequiredRolePolicy({ member: ROLE_MEMBER }),
            goodFacts()
          );
          expect(roleRow(withMember)?.status).to.equal(
            roleRow(withoutMember)?.status
          );
          expect(roleRow(withMember)?.code).to.equal(
            roleRow(withoutMember)?.code
          );
          expect(withMember.proceed).to.equal(withoutMember.proceed);
        });
      });

      it("no solanaRole fact is UNVERIFIED with ROLE_FACT_MISSING", () => {
        const response = run(goodRole(), { now: SWAP_NOW });
        const row = roleRow(response);
        expect(row?.status).to.equal("UNVERIFIED");
        expect(row?.code).to.equal(code("ROLE_FACT_MISSING"));
      });

      [null, "a-string", [], 42, true].forEach((solanaRole) => {
        it(`solanaRole ${JSON.stringify(
          solanaRole
        )} is ROLE_FACT_MISSING`, () => {
          const response = run(goodRole(), { now: SWAP_NOW, solanaRole });
          const row = roleRow(response);
          expect(row?.status).to.equal("UNVERIFIED");
          expect(row?.code).to.equal(code("ROLE_FACT_MISSING"));
        });
      });

      const FACT_MALFORMATIONS: Array<[string, Record<string, unknown>]> = [
        ["subject missing", { subject: undefined }],
        ["subject cluster not a string", makeSubjectOverride({ cluster: 1 })],
        [
          "subject programId not a string",
          makeSubjectOverride({ programId: null }),
        ],
        ["subject role not a string", makeSubjectOverride({ role: {} })],
        ["subject holder not a string", makeSubjectOverride({ holder: [] })],
        ["valid as the string 'true'", { valid: "true" }],
        ["valid as 1", { valid: 1 }],
        ["valid as {}", { valid: {} }],
        ["valid as []", { valid: [] }],
        ["reason outside the enum", { reason: "Whatever" }],
        ["valid true, reason not ok", { valid: true, reason: "RoleDisabled" }],
        ["valid false, reason ok", { valid: false, reason: "ok" }],
        ["provenance missing", { provenance: undefined }],
        [
          "provenance.source empty",
          { provenance: { ...GOOD_PROVENANCE, source: "" } },
        ],
        [
          "provenance.source over 200 chars",
          { provenance: { ...GOOD_PROVENANCE, source: "x".repeat(201) } },
        ],
        [
          "provenance.slot negative",
          { provenance: { ...GOOD_PROVENANCE, slot: -1 } },
        ],
        [
          "provenance.slot a float",
          { provenance: { ...GOOD_PROVENANCE, slot: 1.5 } },
        ],
        [
          "provenance.slot 2**53",
          { provenance: { ...GOOD_PROVENANCE, slot: 2 ** 53 } },
        ],
        [
          "provenance.commitment outside the enum",
          { provenance: { ...GOOD_PROVENANCE, commitment: "processed" } },
        ],
        [
          "provenance.observedAt zero",
          { provenance: { ...GOOD_PROVENANCE, observedAt: 0 } },
        ],
        [
          "provenance.observedAt a string",
          { provenance: { ...GOOD_PROVENANCE, observedAt: "2000000000" } },
        ],
      ];
      FACT_MALFORMATIONS.forEach(([label, overrides]) => {
        it(`fact: ${label} is ROLE_FACT_MALFORMED`, () => {
          const response = run(goodRole(), {
            now: SWAP_NOW,
            solanaRole: makeGoodRoleFact(overrides),
          });
          const row = roleRow(response);
          expect(row?.status, label).to.equal("UNVERIFIED");
          expect(row?.code, label).to.equal(code("ROLE_FACT_MALFORMED"));
        });
      });

      it("a fact whose prototype carries the fields (own properties only) is ROLE_FACT_MALFORMED", () => {
        const inherited = Object.create(makeGoodRoleFact());
        const response = run(goodRole(), {
          now: SWAP_NOW,
          solanaRole: inherited,
        });
        const row = roleRow(response);
        expect(row?.status).to.equal("UNVERIFIED");
        expect(row?.code).to.equal(code("ROLE_FACT_MALFORMED"));
      });

      it("a fact with a getter that answers differently on a second read is read once", () => {
        let reads = 0;
        const facts = {
          now: SWAP_NOW,
          get solanaRole() {
            reads += 1;
            return reads === 1
              ? makeGoodRoleFact()
              : makeGoodRoleFact({ valid: false, reason: "RoleDisabled" });
          },
        };
        const response = run(goodRole(), facts);
        const row = roleRow(response);
        // Only one read happens (inside consult()'s own structuredClone of
        // facts); whatever it returned that one time is what every
        // Condition, including this one, sees from then on.
        expect(reads).to.equal(1);
        expect(row?.status).to.equal("PASS");
        expect(row?.code).to.equal(code("ROLE_HELD"));
      });

      it("a case variant of the policy's holder must NOT pass", () => {
        const response = run(goodRole(), {
          now: SWAP_NOW,
          solanaRole: makeGoodRoleFact(
            {},
            { holder: ROLE_HOLDER.toUpperCase() }
          ),
        });
        const row = roleRow(response);
        expect(row?.status).to.equal("UNVERIFIED");
        expect(row?.code).to.equal(code("ROLE_FACT_SUBJECT_MISMATCH"));
      });

      (
        [
          ["cluster", "devnet"],
          ["programId", ROLE_OTHER_HOLDER],
          ["role", ROLE_OTHER_HOLDER],
          ["holder", ROLE_OTHER_HOLDER],
        ] as Array<[string, string]>
      ).forEach(([field, value]) => {
        it(`subject field ${field} swapped alone is ROLE_FACT_SUBJECT_MISMATCH`, () => {
          const response = run(goodRole(), {
            now: SWAP_NOW,
            solanaRole: makeGoodRoleFact({}, { [field]: value }),
          });
          const row = roleRow(response);
          expect(row?.status, field).to.equal("UNVERIFIED");
          expect(row?.code, field).to.equal(code("ROLE_FACT_SUBJECT_MISMATCH"));
        });
      });

      it("facts.now missing is ROLE_FACT_AGE_UNKNOWN", () => {
        const response = run(goodRole(), { solanaRole: makeGoodRoleFact() });
        const row = roleRow(response);
        expect(row?.status).to.equal("UNVERIFIED");
        expect(row?.code).to.equal(code("ROLE_FACT_AGE_UNKNOWN"));
      });

      const AGE_CASES: Array<[string, number, string]> = [
        ["observedAt equal to now", SWAP_NOW, "PASS"],
        ["observedAt at now - maxAge", SWAP_NOW - ROLE_MAX_AGE_SECONDS, "PASS"],
        [
          "observedAt at now - maxAge - 1",
          SWAP_NOW - ROLE_MAX_AGE_SECONDS - 1,
          "UNVERIFIED",
        ],
        ["observedAt at now + 1 (in the future)", SWAP_NOW + 1, "UNVERIFIED"],
      ];
      AGE_CASES.forEach(([label, observedAt, expected]) => {
        it(`${label} is ${expected}`, () => {
          const response = run(goodRole(), {
            now: SWAP_NOW,
            solanaRole: makeGoodRoleFact({
              provenance: { ...GOOD_PROVENANCE, observedAt },
            }),
          });
          const row = roleRow(response);
          expect(row?.status, label).to.equal(expected);
          if (expected === "UNVERIFIED") {
            expect(row?.code, label).to.equal(code("ROLE_FACT_STALE"));
          } else {
            expect(row?.code, label).to.equal(code("ROLE_HELD"));
          }
        });
      });

      (["float", "string", "2**53"] as const).forEach((kind) => {
        const observedAt =
          kind === "float"
            ? SWAP_NOW + 0.5
            : kind === "string"
            ? String(SWAP_NOW)
            : 2 ** 53;
        it(`observedAt as a ${kind} is ROLE_FACT_MALFORMED`, () => {
          const response = run(goodRole(), {
            now: SWAP_NOW,
            solanaRole: makeGoodRoleFact({
              provenance: {
                ...GOOD_PROVENANCE,
                observedAt: observedAt as never,
              },
            }),
          });
          const row = roleRow(response);
          expect(row?.status, kind).to.equal("UNVERIFIED");
          expect(row?.code, kind).to.equal(code("ROLE_FACT_MALFORMED"));
        });
      });

      (["negative", "float", "2**53"] as const).forEach((kind) => {
        const slot =
          kind === "negative" ? -1 : kind === "float" ? 1.5 : 2 ** 53;
        it(`slot as ${kind} is ROLE_FACT_MALFORMED`, () => {
          const response = run(goodRole(), {
            now: SWAP_NOW,
            solanaRole: makeGoodRoleFact({
              provenance: { ...GOOD_PROVENANCE, slot },
            }),
          });
          const row = roleRow(response);
          expect(row?.status, kind).to.equal("UNVERIFIED");
          expect(row?.code, kind).to.equal(code("ROLE_FACT_MALFORMED"));
        });
      });

      const FAIL_REASONS: Array<[string, string]> = [
        ["RoleDisabled", "ROLE_DISABLED"],
        ["MembershipExpired", "ROLE_MEMBERSHIP_EXPIRED"],
        ["MemberMissing", "ROLE_MEMBER_MISSING"],
      ];
      FAIL_REASONS.forEach(([reason, failCode]) => {
        it(`valid:false with reason ${reason} FAILs with ${failCode}`, () => {
          const response = run(goodRole(), {
            now: SWAP_NOW,
            solanaRole: makeGoodRoleFact({ valid: false, reason }),
          });
          const row = roleRow(response);
          expect(row?.status).to.equal("FAIL");
          expect(row?.code).to.equal(code(failCode));
          expect(row?.evidenceClass).to.equal("onchain-read");
          expect(response.verdict).to.equal("DENY");
        });
      });

      describe("property loop: a good (policy.role, fact) pair", () => {
        it("mutating any single field never keeps ROLE_HELD unless the mutated value is identical", () => {
          const mutations: Array<{
            label: string;
            build: () => { role: unknown; facts: unknown };
          }> = [
            {
              label: "cluster",
              build: () => ({
                role: makeRequiredRolePolicy({ cluster: "devnet" }),
                facts: goodFacts(),
              }),
            },
            {
              label: "programId",
              build: () => ({
                role: makeRequiredRolePolicy({ programId: ROLE_OTHER_HOLDER }),
                facts: goodFacts(),
              }),
            },
            {
              label: "role",
              build: () => ({
                role: makeRequiredRolePolicy({ role: ROLE_OTHER_HOLDER }),
                facts: goodFacts(),
              }),
            },
            {
              label: "holder",
              build: () => ({
                role: makeRequiredRolePolicy({ holder: ROLE_OTHER_HOLDER }),
                facts: goodFacts(),
              }),
            },
            {
              label: "maxAgeSeconds",
              build: () => ({
                role: makeRequiredRolePolicy({ maxAgeSeconds: 1 }),
                facts: {
                  now: SWAP_NOW,
                  solanaRole: makeGoodRoleFact({
                    provenance: {
                      ...GOOD_PROVENANCE,
                      observedAt: SWAP_NOW - 5,
                    },
                  }),
                },
              }),
            },
            {
              label: "fact.valid",
              build: () => ({
                role: goodRole(),
                facts: {
                  now: SWAP_NOW,
                  solanaRole: makeGoodRoleFact({
                    valid: false,
                    reason: "RoleDisabled",
                  }),
                },
              }),
            },
            {
              label: "fact.subject.holder",
              build: () => ({
                role: goodRole(),
                facts: {
                  now: SWAP_NOW,
                  solanaRole: makeGoodRoleFact(
                    {},
                    { holder: ROLE_OTHER_HOLDER }
                  ),
                },
              }),
            },
            {
              label: "fact.provenance.observedAt (identical value)",
              build: () => ({ role: goodRole(), facts: goodFacts() }),
            },
          ];

          let checked = 0;
          mutations.forEach(({ label, build }) => {
            const { role, facts } = build();
            const response = run(role, facts);
            const row = roleRow(response);
            checked += 1;
            if (label === "fact.provenance.observedAt (identical value)") {
              expect(row?.code, label).to.equal(code("ROLE_HELD"));
            } else {
              expect(row?.code, label).to.not.equal(code("ROLE_HELD"));
            }
          });
          expect(checked).to.equal(mutations.length);
        });
      });
    });
  });
});
