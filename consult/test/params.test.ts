import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import { checkParam, isParams } from "../src/params";

// The labelled fixture bundle: fake, self-describing values only. No real
// value is in this repo.
const BUNDLE_PATH = join(__dirname, "fixtures", "params-bundle.json");
const bundle = (): Record<string, Record<string, Record<string, unknown>>> =>
  JSON.parse(readFileSync(BUNDLE_PATH, "utf8"));

const ID = "fixture-params-alpha";
const SEVEN_FIELDS = [
  "value",
  "unit",
  "id",
  "asOf",
  "paramsSha256",
  "scrub",
  "used_by",
];

describe("params: the Params type and its shape guard", () => {
  it("accepts the fixture bundle", () => {
    expect(isParams(bundle())).to.equal(true);
  });

  it("every constant in the bundle carries the seven fields, used_by included", () => {
    const params = bundle();
    const constants = Object.values(params).flatMap((file) =>
      Object.values(file)
    );
    expect(constants.length).to.be.greaterThan(0);
    constants.forEach((constant) => {
      expect(constant).to.include.keys(SEVEN_FIELDS);
      expect(constant.scrub).to.include.keys(["reviewer", "date", "sha256"]);
    });
  });

  it("the bundle carries check, both, and labels a Check may not read", () => {
    const labels = Object.values(bundle()[ID]).map((c) => c.used_by);
    expect(labels).to.include.members(["check", "both", "next"]);
    expect(labels.filter((l) => l !== "check" && l !== "both")).to.have.length(
      3
    );
  });

  for (const field of SEVEN_FIELDS) {
    it(`rejects a constant missing ${field}`, () => {
      const params = bundle();
      delete params[ID].fixture_check_a[field];
      expect(isParams(params)).to.equal(false);
    });
  }

  for (const field of ["reviewer", "date", "sha256"]) {
    it(`rejects a scrub record missing ${field}`, () => {
      const params = bundle();
      delete (params[ID].fixture_check_a.scrub as Record<string, unknown>)[
        field
      ];
      expect(isParams(params)).to.equal(false);
    });
  }

  for (const label of ["", 7, null]) {
    it(`rejects a used_by of ${JSON.stringify(label)}`, () => {
      const params = bundle();
      params[ID].fixture_check_a.used_by = label;
      expect(isParams(params)).to.equal(false);
    });
  }

  it("accepts a used_by label this package does not name: the service owns the label set", () => {
    const params = bundle();
    params[ID].fixture_check_a.used_by = "fixture-label-new";
    expect(isParams(params)).to.equal(true);
  });

  it("rejects a null value: a missing number stays missing", () => {
    const params = bundle();
    params[ID].fixture_check_a.value = null;
    expect(isParams(params)).to.equal(false);
  });

  it("rejects a constant whose id is not the params id it sits under", () => {
    const params = bundle();
    params[ID].fixture_check_a.id = "fixture-params-other";
    expect(isParams(params)).to.equal(false);
  });

  it("rejects a hash that is not 64 lowercase hex characters", () => {
    const params = bundle();
    params[ID].fixture_check_a.paramsSha256 = "AA";
    expect(isParams(params)).to.equal(false);
  });

  for (const [label, value] of [
    ["undefined", undefined],
    ["null", null],
    ["a string", "params"],
    ["a number", 7],
    ["an array", []],
    ["a file holding an array", { [ID]: [] }],
    ["a constant that is a string", { [ID]: { fixture_check_a: "x" } }],
  ] as const) {
    it(`rejects ${label}`, () => {
      expect(isParams(value)).to.equal(false);
    });
  }
});

describe("params: checkParam, the one way a Condition reads a constant", () => {
  it("returns a check constant with its provenance", () => {
    const constant = checkParam(bundle(), ID, "fixture_check_a");
    expect(constant?.used_by).to.equal("check");
    expect(constant?.paramsSha256).to.equal("a".repeat(64));
  });

  it("returns a both constant", () => {
    expect(checkParam(bundle(), ID, "fixture_both_b")?.used_by).to.equal(
      "both"
    );
  });

  for (const key of [
    "fixture_other_c",
    "fixture_unassigned_d",
    "fixture_next_e",
  ]) {
    it(`never returns ${key}: a Check reads only check or both`, () => {
      expect(checkParam(bundle(), ID, key)).to.equal(undefined);
    });
  }

  it("returns nothing for a constant that is not there", () => {
    expect(checkParam(bundle(), ID, "fixture_missing")).to.equal(undefined);
    expect(
      checkParam(bundle(), "fixture-params-missing", "fixture_check_a")
    ).to.equal(undefined);
  });

  it("treats absent facts.params as absent", () => {
    expect(checkParam(undefined, ID, "fixture_check_a")).to.equal(undefined);
  });

  it("treats a partial facts.params as absent, even for the constants that are whole", () => {
    const params = bundle();
    delete params[ID].fixture_both_b.scrub;
    expect(checkParam(params, ID, "fixture_check_a")).to.equal(undefined);
  });

  it("treats a malformed facts.params as absent", () => {
    expect(
      checkParam({ [ID]: "not an object" }, ID, "fixture_check_a")
    ).to.equal(undefined);
  });

  it("never reads an inherited key", () => {
    expect(checkParam(bundle(), ID, "toString")).to.equal(undefined);
    expect(checkParam(bundle(), "constructor", "fixture_check_a")).to.equal(
      undefined
    );
  });
});
