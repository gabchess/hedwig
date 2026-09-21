import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

const SRC_DIR = join(__dirname, "..", "src");

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR).filter((file) => file.endsWith(".ts"));
}

describe("mcp/src source boundary", () => {
  it("never imports consult's internals by a relative path", () => {
    sourceFiles().forEach((file) => {
      const contents = readFileSync(join(SRC_DIR, file), "utf8");
      expect(contents).to.not.include("../consult/src");
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
