import { expect } from "chai";

import {
  __resetSolanaClusterConfigForTests,
  getSolanaClusterConfig,
  readClusterConfig,
} from "../../src/readers/config";

function captureErrors(): { lines: string[]; restore: () => void } {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  return { lines, restore: () => (console.error = original) };
}

describe("readers/config: readClusterConfig (env injected, never process.env)", () => {
  it("accepts https: with no further restriction", () => {
    const { lines, restore } = captureErrors();
    const config = readClusterConfig("devnet", {
      HEDWIG_SOLANA_RPC_URL_DEVNET: "https://api.devnet.solana.com/",
      HEDWIG_SOLANA_FEE_PAYER_DEVNET:
        "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    });
    restore();
    expect(config).to.deep.equal({
      rpcUrl: "https://api.devnet.solana.com/",
      feePayer: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    });
    expect(lines).to.have.length(0);
  });

  ["localhost", "127.0.0.1", "[::1]"].forEach((host) => {
    it(`accepts http: for ${host} (after URL normalisation)`, () => {
      const raw = `hTTp://${host.toUpperCase()}:8899/`;
      const { restore } = captureErrors();
      const config = readClusterConfig("devnet", {
        HEDWIG_SOLANA_RPC_URL_DEVNET: raw,
        HEDWIG_SOLANA_FEE_PAYER_DEVNET: "fee-payer",
      });
      restore();
      expect(config?.rpcUrl).to.equal(raw);
    });
  });

  it("rejects http: for a non-loopback host", () => {
    const { lines, restore } = captureErrors();
    const config = readClusterConfig("devnet", {
      HEDWIG_SOLANA_RPC_URL_DEVNET: "http://rpc.example.com/",
      HEDWIG_SOLANA_FEE_PAYER_DEVNET: "fee-payer",
    });
    restore();
    expect(config).to.equal(undefined);
    expect(lines).to.have.length(1);
  });

  it("rejects a URL with user-info at configuration time", () => {
    const canary = "CANARY-USERINFO-SECRET";
    const { lines, restore } = captureErrors();
    const config = readClusterConfig("devnet", {
      HEDWIG_SOLANA_RPC_URL_DEVNET: `https://user:${canary}@rpc.example.com/`,
      HEDWIG_SOLANA_FEE_PAYER_DEVNET: "fee-payer",
    });
    restore();
    expect(config).to.equal(undefined);
    expect(lines).to.have.length(1);
    expect(lines[0]).to.not.include(canary);
  });

  it("_MAINNET never falls back to a _DEVNET value, or vice versa", () => {
    const { restore } = captureErrors();
    const devnetOnly = readClusterConfig("mainnet-beta", {
      HEDWIG_SOLANA_RPC_URL_DEVNET: "https://api.devnet.solana.com/",
      HEDWIG_SOLANA_FEE_PAYER_DEVNET: "devnet-fee-payer",
    });
    const mainnetOnly = readClusterConfig("devnet", {
      HEDWIG_SOLANA_RPC_URL_MAINNET: "https://api.mainnet-beta.solana.com/",
      HEDWIG_SOLANA_FEE_PAYER_MAINNET: "mainnet-fee-payer",
    });
    restore();
    expect(devnetOnly).to.equal(undefined);
    expect(mainnetOnly).to.equal(undefined);
  });

  it("the URL's value never reaches a log line, in the path, query, or user-info", () => {
    const pathCanary = "CANARY-PATH-VALUE";
    const { lines, restore } = captureErrors();
    readClusterConfig("devnet", {
      // http: for a non-loopback host: rejected, and must not echo the URL.
      HEDWIG_SOLANA_RPC_URL_DEVNET: `http://rpc.example.com/${pathCanary}?key=${pathCanary}`,
      HEDWIG_SOLANA_FEE_PAYER_DEVNET: "fee-payer",
    });
    restore();
    expect(lines.join("\n")).to.not.include(pathCanary);
  });

  it("logs the variable name, never a value, when the fee payer is missing", () => {
    const { lines, restore } = captureErrors();
    readClusterConfig("devnet", {
      HEDWIG_SOLANA_RPC_URL_DEVNET: "https://api.devnet.solana.com/",
    });
    restore();
    expect(lines).to.deep.equal(["HEDWIG_SOLANA_FEE_PAYER_DEVNET is not set"]);
  });
});

describe("readers/config: getSolanaClusterConfig (memoization over real process.env)", () => {
  let originalUrl: string | undefined;
  let originalFeePayer: string | undefined;

  beforeEach(() => {
    originalUrl = process.env.HEDWIG_SOLANA_RPC_URL_DEVNET;
    originalFeePayer = process.env.HEDWIG_SOLANA_FEE_PAYER_DEVNET;
    delete process.env.HEDWIG_SOLANA_RPC_URL_DEVNET;
    delete process.env.HEDWIG_SOLANA_FEE_PAYER_DEVNET;
    __resetSolanaClusterConfigForTests();
  });

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.HEDWIG_SOLANA_RPC_URL_DEVNET;
    } else {
      process.env.HEDWIG_SOLANA_RPC_URL_DEVNET = originalUrl;
    }
    if (originalFeePayer === undefined) {
      delete process.env.HEDWIG_SOLANA_FEE_PAYER_DEVNET;
    } else {
      process.env.HEDWIG_SOLANA_FEE_PAYER_DEVNET = originalFeePayer;
    }
    __resetSolanaClusterConfigForTests();
  });

  it("prints the missing-variable lines once across many calls", () => {
    const { lines, restore } = captureErrors();
    getSolanaClusterConfig("devnet");
    getSolanaClusterConfig("devnet");
    getSolanaClusterConfig("devnet");
    restore();
    expect(lines).to.have.length(2); // URL missing, fee payer missing: once each
  });

  it("an unrecognised cluster string never reads or logs anything", () => {
    const { lines, restore } = captureErrors();
    const config = getSolanaClusterConfig("testnet");
    restore();
    expect(config).to.equal(undefined);
    expect(lines).to.have.length(0);
  });
});
