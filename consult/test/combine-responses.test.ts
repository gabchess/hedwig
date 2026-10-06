import { expect } from "chai";

import { combineResponses } from "../src/core";
import type { ConsultResponse } from "../src/core";
import type { ConditionResult } from "../src/types";

const result = (
  id: string,
  status: ConditionResult["status"],
  evidenceClass: ConditionResult["evidenceClass"] = "static-registry"
): ConditionResult => ({
  id,
  question: `Is ${id} fine?`,
  status,
  code: `CODE_${status}`,
  evidence: status === "UNVERIFIED" ? "cannot confirm: test" : "test",
  evidenceClass,
  reference: "consult/references/core.md",
});

const response = (
  results: ConditionResult[],
  proceed: boolean,
  floorIds: string[],
  support = 1
): ConsultResponse => ({
  question: "Should this agent proceed?",
  proceed,
  verdict: proceed ? "ALLOW_UNDER_POLICY" : "UNKNOWN",
  support,
  band: "red",
  results,
  floorIds,
  advisory: true,
});

describe("combineResponses", () => {
  it("keeps the worse status when both responses name one Condition", () => {
    const pass = response([result("a", "PASS")], true, ["a"]);
    const fail = response([result("a", "FAIL")], false, ["a"]);
    for (const [first, second] of [
      [pass, fail],
      [fail, pass],
    ]) {
      const merged = combineResponses(first, second);
      expect(merged.results).to.have.length(1);
      expect(merged.results[0].status).to.equal("FAIL");
      expect(merged.verdict).to.equal("DENY");
      expect(merged.proceed).to.equal(false);
    }
    const unverified = response([result("a", "UNVERIFIED")], false, ["a"]);
    expect(combineResponses(pass, unverified).results[0].status).to.equal(
      "UNVERIFIED"
    );
    expect(combineResponses(unverified, pass).results[0].status).to.equal(
      "UNVERIFIED"
    );
  });

  it("unions the rows and the Floor ids, one row per id", () => {
    const first = response([result("a", "PASS"), result("b", "PASS")], true, [
      "a",
      "b",
    ]);
    const second = response([result("b", "PASS"), result("c", "PASS")], true, [
      "b",
      "c",
    ]);
    const merged = combineResponses(first, second);
    expect(merged.results.map((r) => r.id).sort()).to.deep.equal([
      "a",
      "b",
      "c",
    ]);
    expect([...merged.floorIds].sort()).to.deep.equal(["a", "b", "c"]);
    expect(merged.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(merged.proceed).to.equal(true);
    expect(merged.support).to.equal(0.92);
  });

  it("an ALLOW needs both responses to proceed", () => {
    const go = response([result("a", "PASS")], true, ["a"]);
    const hold = response([result("b", "PASS")], false, ["b"]);
    expect(combineResponses(go, hold).verdict).to.equal("UNKNOWN");
    expect(combineResponses(hold, go).verdict).to.equal("UNKNOWN");
    expect(combineResponses(hold, hold).verdict).to.equal("UNKNOWN");
    expect(combineResponses(go, go).verdict).to.equal("ALLOW_UNDER_POLICY");
  });

  it("support is recomputed after the verdict, over the merged rows", () => {
    const weak = response([result("a", "PASS", "simulated")], true, ["a"]);
    const strong = response([result("b", "PASS", "onchain-read")], true, ["b"]);
    expect(combineResponses(weak, strong).support).to.equal(0.91);
    const denied = combineResponses(
      weak,
      response([result("c", "FAIL")], false, ["c"])
    );
    expect(denied.support).to.equal(0);
    expect(denied.band).to.equal("red");
  });

  it("the merged support never exceeds the lower of the two inputs, and the band follows it", () => {
    const high = response([result("a", "PASS")], true, ["a"], 0.9);
    const low = response([result("b", "UNVERIFIED")], false, ["b"], 0.15);
    for (const merged of [
      combineResponses(high, low),
      combineResponses(low, high),
    ]) {
      expect(merged.verdict).to.equal("UNKNOWN");
      expect(merged.support).to.be.at.most(0.15);
      expect(merged.band).to.equal("red");
    }
  });
});
