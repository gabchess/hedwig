import { expect } from "chai";

import { describeCatalog } from "../src/introspect";
import { CATALOG, CANONICAL_ASSETS, CANONICAL_ROUTERS } from "../src/catalog";

// Walks the whole returned tree: every object and array must already be
// frozen, and no function value may appear anywhere in it.
function assertFrozenAndDataOnly(value: unknown, path: string): void {
  if (typeof value === "function") {
    throw new Error(`introspect exposed a function at ${path}`);
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  expect(Object.isFrozen(value), path).to.equal(true);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertFrozenAndDataOnly(entry, `${path}[${index}]`)
    );
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    assertFrozenAndDataOnly(entry, `${path}.${key}`);
  }
}

describe("introspect", () => {
  it("returns a deep-frozen, function-free description", () => {
    assertFrozenAndDataOnly(describeCatalog(), "describeCatalog()");
  });

  it("returns a fresh object on every call", () => {
    expect(describeCatalog()).to.not.equal(describeCatalog());
    expect(describeCatalog()).to.deep.equal(describeCatalog());
  });

  it("names every action type the real catalog knows", () => {
    const description = describeCatalog();
    expect(description.actionTypes).to.have.members(Object.keys(CATALOG));
  });

  it("describes every Condition in the real catalog, grouped by identical shape", () => {
    const description = describeCatalog();
    const totalConditions = Object.values(CATALOG).flat().length;
    const totalActionTypes = description.conditions.reduce(
      (sum, condition) => sum + condition.actionTypes.length,
      0
    );
    // No two Conditions in the real catalog happen to share every field
    // (question, reference, floor flag, and codes), so grouping never
    // collapses any of them: one description row per catalog Condition.
    expect(description.conditions.length).to.equal(totalConditions);
    expect(totalActionTypes).to.equal(totalConditions);
  });

  it("describes a known pay Floor Condition faithfully", () => {
    const description = describeCatalog();
    const recipientMatchesPolicy = description.conditions.find(
      (condition) =>
        condition.id === "recipient-matches-policy" &&
        condition.actionTypes.includes("pay")
    );
    expect(recipientMatchesPolicy, "recipient-matches-policy").to.exist;
    expect(recipientMatchesPolicy!.floor).to.equal(true);
    expect(recipientMatchesPolicy!.actionTypes).to.deep.equal(["pay"]);
    expect(recipientMatchesPolicy!.codes.pass).to.deep.equal([
      "RECIPIENT_MATCHES_POLICY",
    ]);
    expect(recipientMatchesPolicy!.reference).to.equal(
      "consult/references/pay/recipient-matches-policy.md"
    );
    expect(
      recipientMatchesPolicy!.evidenceClass.RECIPIENT_MATCHES_POLICY
    ).to.equal("owner-policy");
  });

  it("reports the same canonical asset and router tables catalog.ts binds against", () => {
    const description = describeCatalog();
    expect(description.canonicalAssets).to.deep.equal(CANONICAL_ASSETS);
    for (const [chainId, address] of Object.entries(CANONICAL_ROUTERS)) {
      expect(description.canonicalRouters[chainId]).to.deep.equal({
        "universal-router": address,
      });
    }
  });
});
