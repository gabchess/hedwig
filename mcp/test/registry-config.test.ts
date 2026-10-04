import { homedir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";

import { readEvmRpcUrl, readRegistryConfig } from "../src/readers/config";

// The registry Reader's settings are read from the environment only, and
// the log lines name a variable, never a URL (an RPC URL carries its key).

function captured<T>(run: () => T): { value: T; lines: string[] } {
  const lines: string[] = [];
  const real = console.error;
  console.error = (line: unknown) => lines.push(String(line));
  try {
    return { value: run(), lines };
  } finally {
    console.error = real;
  }
}

describe("registry config", () => {
  describe("readRegistryConfig", () => {
    it("reads an https base URL and drops trailing slashes", () => {
      const { value, lines } = captured(() =>
        readRegistryConfig({
          HEDWIG_REGISTRY_URL: "https://registry.test/site//",
        })
      );
      expect(value).to.deep.equal({
        baseUrl: "https://registry.test/site",
        ratchetFile: join(homedir(), ".hedwig", "registry-ratchet.json"),
      });
      expect(lines).to.deep.equal([]);
    });

    it("takes the ratchet file from its own variable", () => {
      const { value } = captured(() =>
        readRegistryConfig({
          HEDWIG_REGISTRY_URL: "https://registry.test",
          HEDWIG_REGISTRY_RATCHET_FILE: "/var/lib/hedwig/ratchet.json",
        })
      );
      expect(value?.ratchetFile).to.equal("/var/lib/hedwig/ratchet.json");
    });

    it("allows plain http only on a loopback host", () => {
      for (const url of ["http://localhost:8787", "http://127.0.0.1:8787"]) {
        expect(
          captured(() => readRegistryConfig({ HEDWIG_REGISTRY_URL: url })).value
            ?.baseUrl
        ).to.equal(url);
      }
      const { value, lines } = captured(() =>
        readRegistryConfig({ HEDWIG_REGISTRY_URL: "http://registry.test" })
      );
      expect(value).to.equal(undefined);
      expect(lines).to.deep.equal(["HEDWIG_REGISTRY_URL is not a usable URL"]);
    });

    it("answers undefined and names only the variable when unset or unusable, never the URL", () => {
      const unset = captured(() => readRegistryConfig({}));
      expect(unset.value).to.equal(undefined);
      expect(unset.lines).to.deep.equal(["HEDWIG_REGISTRY_URL is not set"]);
      for (const url of [
        "not a url",
        "ftp://registry.test",
        "https://user:pass-SECRET@registry.test",
        "https://registry.test/?key=SECRET",
        "https://registry.test/#SECRET",
      ]) {
        const { value, lines } = captured(() =>
          readRegistryConfig({ HEDWIG_REGISTRY_URL: url })
        );
        expect(value, url).to.equal(undefined);
        expect(lines, url).to.deep.equal([
          "HEDWIG_REGISTRY_URL is not a usable URL",
        ]);
      }
    });
  });

  describe("readEvmRpcUrl", () => {
    it("reads the variable named for that chain number only", () => {
      const env = {
        HEDWIG_EVM_RPC_URL_143: "https://rpc.test/v2/KEY-143",
        HEDWIG_EVM_RPC_URL_1: "https://rpc.test/v2/KEY-1",
      };
      expect(captured(() => readEvmRpcUrl(143, env)).value).to.equal(
        env.HEDWIG_EVM_RPC_URL_143
      );
      expect(captured(() => readEvmRpcUrl(1, env)).value).to.equal(
        env.HEDWIG_EVM_RPC_URL_1
      );
      const other = captured(() => readEvmRpcUrl(8453, env));
      expect(other.value).to.equal(undefined);
      expect(other.lines).to.deep.equal(["HEDWIG_EVM_RPC_URL_8453 is not set"]);
    });

    it("refuses a chain number that is not a positive safe integer without touching the env", () => {
      const env = new Proxy({} as NodeJS.ProcessEnv, {
        get() {
          throw new Error("read the env");
        },
      });
      for (const n of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect(readEvmRpcUrl(n, env)).to.equal(undefined);
      }
    });

    it("never logs the URL when it is unusable", () => {
      for (const url of [
        "not a url",
        "http://rpc.test/v2/SECRET",
        "https://user:SECRET@rpc.test/v2/key",
      ]) {
        const { value, lines } = captured(() =>
          readEvmRpcUrl(143, { HEDWIG_EVM_RPC_URL_143: url })
        );
        expect(value, url).to.equal(undefined);
        expect(lines, url).to.deep.equal([
          "HEDWIG_EVM_RPC_URL_143 is not a usable URL",
        ]);
      }
    });
  });
});
