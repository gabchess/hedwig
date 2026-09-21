import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "chai";

// The package manifest is the door: it must expose exactly "." and nothing
// else, so a caller can never reach consult/src/internal.ts or any other
// file directly. This resolves the deep paths through a real Node
// node_modules lookup (a symlink, no install, no network) rather than just
// re-reading the same package.json the implementation reads, so the test
// fails the way a real caller's `require` would.
const CONSULT_ROOT = resolve(__dirname, "..");

describe("package door", () => {
  it("exports exactly one entry point, the package root", () => {
    const pkg = JSON.parse(
      readFileSync(join(CONSULT_ROOT, "package.json"), "utf8")
    );
    expect(Object.keys(pkg.exports)).to.deep.equal(["."]);
  });

  describe("deep import paths", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "consult-door-"));
      mkdirSync(join(tmpDir, "node_modules", "@hedwig"), { recursive: true });
      symlinkSync(
        CONSULT_ROOT,
        join(tmpDir, "node_modules", "@hedwig", "consult"),
        "dir"
      );
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    const BLOCKED_PATHS = [
      "@hedwig/consult/src/internal",
      "@hedwig/consult/src/core",
      "@hedwig/consult/internal",
      "@hedwig/consult/core",
      "@hedwig/consult/package.json",
    ];

    for (const deepPath of BLOCKED_PATHS) {
      it(`refuses to resolve ${deepPath}`, () => {
        let error: NodeJS.ErrnoException | undefined;
        try {
          require.resolve(deepPath, { paths: [tmpDir] });
        } catch (caught) {
          error = caught as NodeJS.ErrnoException;
        }
        expect(error?.code).to.equal("ERR_PACKAGE_PATH_NOT_EXPORTED");
      });
    }
  });
});
