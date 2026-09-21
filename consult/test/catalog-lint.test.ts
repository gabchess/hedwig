import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import { PAY_CATALOG } from "../src/catalog";
import type { ConditionDefinition } from "../src/catalog";

const REPO_ROOT = join(__dirname, "..", "..");
const CODE_SHAPE = /^[A-Z][A-Z0-9_]+$/;
const VALID_EVIDENCE_CLASSES = new Set([
  "onchain-read",
  "owner-policy",
  "static-registry",
  "not-verifiable",
]);

function allConditions(): ConditionDefinition[] {
  return Object.values(PAY_CATALOG).flat();
}

describe("catalog lint", () => {
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
      expect(condition.codes.pass, condition.id).to.be.a("string").that.is.not
        .empty;
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
        condition.codes.pass,
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
      const codes = [
        condition.codes.pass,
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
      expect(
        condition.codeEvidenceClass[condition.codes.pass],
        condition.id
      ).to.not.equal("not-verifiable");
    });
  });
});
