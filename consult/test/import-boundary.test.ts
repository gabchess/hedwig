import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

// fold.ts owns the verdict decision (foldVerdict) and nothing else. The
// support score is computed AFTER the verdict and must never be able to
// influence it, so fold.ts is not allowed to import the module that
// computes it, or even know the module exists. This reads the source text
// directly rather than trusting a code review: the assertion breaks the
// moment an import is added, however innocuous it looks.
const FOLD_SOURCE = readFileSync(
  join(__dirname, "..", "src", "fold.ts"),
  "utf8"
);

describe("fold.ts import boundary", () => {
  it("imports nothing", () => {
    expect(FOLD_SOURCE).to.not.match(/^\s*import\b/m);
  });

  it("never references the support module by path", () => {
    expect(FOLD_SOURCE.toLowerCase()).to.not.include("./support");
    expect(FOLD_SOURCE.toLowerCase()).to.not.include('"support"');
  });
});
