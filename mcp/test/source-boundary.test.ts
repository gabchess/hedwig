import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

const SRC_DIR = join(__dirname, "..", "src");

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR).filter((file) => file.endsWith(".ts"));
}

// Matches any quoted import specifier containing "consult/" - a path into
// the package's insides, whether source (../consult/src) or build output
// (consult/dist) - but not the bare package name "@hedwig/consult" itself,
// which has no trailing slash.
const CONSULT_SUBPATH_IMPORT =
  /(?:from\s+|require\()\s*["'][^"']*consult\/[^"']*["']/;

describe("mcp/src source boundary", () => {
  it("never imports a path inside consult/ (source or build output)", () => {
    sourceFiles().forEach((file) => {
      const contents = readFileSync(join(SRC_DIR, file), "utf8");
      expect(contents).to.not.match(CONSULT_SUBPATH_IMPORT);
    });
  });

  it("never references consult's private catalog or its internal door", () => {
    const banned = ["consultWith", "internal", "PAY_CATALOG", "catalog"];
    sourceFiles().forEach((file) => {
      const contents = readFileSync(join(SRC_DIR, file), "utf8");
      banned.forEach((token) => {
        expect(contents).to.not.include(token);
      });
    });
  });

  it("never references a network primitive", () => {
    const banned = ["fetch(", "node:http", "node:https", "node:net"];
    sourceFiles().forEach((file) => {
      const contents = readFileSync(join(SRC_DIR, file), "utf8");
      banned.forEach((token) => {
        expect(contents).to.not.include(token);
      });
    });
  });
});
