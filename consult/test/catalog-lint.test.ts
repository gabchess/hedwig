import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import {
  CATALOG,
  POLICY_READING_CONDITION_IDS,
  passCodesOf,
  validateCatalog,
} from "../src/catalog";
import type { Catalog, ConditionDefinition } from "../src/catalog";

const REPO_ROOT = join(__dirname, "..", "..");
const CODE_SHAPE = /^[A-Z][A-Z0-9_]+$/;
const VALID_EVIDENCE_CLASSES = new Set([
  "onchain-read",
  "owner-policy",
  "static-registry",
  "caller-stated",
  "not-verifiable",
]);

// Every action type the real catalog knows, pay and swap alike: no special
// case for either.
function allConditions(): ConditionDefinition[] {
  return Object.values(CATALOG).flat();
}

describe("catalog lint", () => {
  it("covers both pay and swap, not just one action type", () => {
    expect(Object.keys(CATALOG)).to.have.members(["pay", "swap"]);
    expect(allConditions().length).to.be.greaterThan(6);
  });

  it("every Condition has a non-empty question ending in a question mark", () => {
    allConditions().forEach((condition) => {
      expect(condition.question, condition.id).to.be.a("string").that.is.not
        .empty;
      expect(condition.question.trim().endsWith("?"), condition.id).to.equal(
        true
      );
    });
  });

  it("every Condition declares at least one PASS, one FAIL, and one UNVERIFIED code", () => {
    allConditions().forEach((condition) => {
      const passList = passCodesOf(condition.codes);
      expect(passList, condition.id).to.be.an("array").that.is.not.empty;
      passList.forEach((code) => {
        expect(code, condition.id).to.be.a("string").that.is.not.empty;
      });
      expect(condition.codes.fail, condition.id).to.be.an("array").that.is.not
        .empty;
      expect(condition.codes.unverified, condition.id).to.be.an("array").that.is
        .not.empty;
    });
  });

  it("every declared code is unique across the whole catalog and shaped SCREAMING_SNAKE_CASE", () => {
    const seen = new Set<string>();
    allConditions().forEach((condition) => {
      const codes = [
        ...passCodesOf(condition.codes),
        ...condition.codes.fail,
        ...condition.codes.unverified,
      ];
      codes.forEach((code) => {
        expect(code, `${condition.id}: ${code}`).to.match(CODE_SHAPE);
        expect(seen.has(code), `duplicate code ${code}`).to.equal(false);
        seen.add(code);
      });
    });
    expect(seen.size).to.be.greaterThan(0);
  });

  it("every Condition has a reference whose file exists and is non-empty", () => {
    allConditions().forEach((condition) => {
      const path = join(REPO_ROOT, condition.reference);
      expect(existsSync(path), condition.reference).to.equal(true);
      const contents = readFileSync(path, "utf8");
      expect(contents.trim(), condition.reference).to.not.be.empty;
    });
  });

  it("declares exactly one evidence class per declared outcome, and it is a valid class", () => {
    allConditions().forEach((condition) => {
      const passList = passCodesOf(condition.codes);
      const codes = [
        ...passList,
        ...condition.codes.fail,
        ...condition.codes.unverified,
      ];
      codes.forEach((code) => {
        const evidenceClass = condition.codeEvidenceClass[code];
        expect(evidenceClass, `${condition.id}: ${code}`).to.exist;
        expect(VALID_EVIDENCE_CLASSES.has(evidenceClass), code).to.equal(true);
      });
      // A PASS documented as resting on unverifiable evidence would be a
      // contradiction the catalog itself should never ship.
      passList.forEach((code) => {
        expect(
          condition.codeEvidenceClass[code],
          `${condition.id}: ${code}`
        ).to.not.equal("not-verifiable");
      });
    });
  });

  it("declares policyFields as an array of non-empty strings wherever present", () => {
    allConditions().forEach((condition) => {
      if (condition.policyFields === undefined) {
        return;
      }
      expect(condition.policyFields, condition.id).to.be.an("array");
      condition.policyFields.forEach((field) => {
        expect(field, condition.id).to.be.a("string").that.is.not.empty;
      });
    });
  });

  it("declares a non-empty policyFields for every Condition known to read the owner's policy", () => {
    allConditions().forEach((condition) => {
      if (!POLICY_READING_CONDITION_IDS.has(condition.id)) {
        return;
      }
      expect(condition.policyFields, condition.id).to.be.an("array").that.is.not
        .empty;
    });
  });

  it("validateCatalog rejects a policy-reading Condition whose policyFields was blanked", () => {
    // A mutated copy, never the real CATALOG: proves the enforcement fires,
    // it does not touch the catalog consult() actually binds to.
    const mutated: Catalog = {
      ...CATALOG,
      pay: CATALOG.pay.map((condition) =>
        condition.id === "recipient-matches-policy"
          ? { ...condition, policyFields: [] }
          : condition
      ),
    };
    expect(validateCatalog(mutated)).to.be.a("string");
    expect(validateCatalog(CATALOG)).to.equal(undefined);
  });
});
