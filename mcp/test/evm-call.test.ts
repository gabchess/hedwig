import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { handleConsult } from "../src/handler";
import registryReader = require("../src/readers/registry-asset");
import solanaReader = require("../src/readers/solana-role");
import {
  makePolicy,
  makeRequest,
  makeSwapPolicy,
  makeSwapRequest,
} from "../../consult/test/fixtures";

describe("EVM call preflight before evidence readers", () => {
  let dir: string;
  let policyPath: string;
  let readerCalls: string[];
  let originalRegistry: typeof registryReader.gatherRegistry;
  let originalSolana: typeof solanaReader.gatherSolanaRole;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-evm-preflight-"));
    policyPath = join(dir, "policy.json");
    readerCalls = [];
    originalRegistry = registryReader.gatherRegistry;
    originalSolana = solanaReader.gatherSolanaRole;
    // Evidence acquisition is the side effect under test. These boundary
    // spies also prevent a regression from reaching any configured provider.
    registryReader.gatherRegistry = async () => {
      readerCalls.push("registry");
      return {};
    };
    solanaReader.gatherSolanaRole = async () => {
      readerCalls.push("solana");
      return undefined;
    };
  });
  afterEach(() => {
    registryReader.gatherRegistry = originalRegistry;
    solanaReader.gatherSolanaRole = originalSolana;
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a payment without bytes before dispatching readers", async () => {
    writeFileSync(policyPath, JSON.stringify(makePolicy()));
    const result = await handleConsult(
      { request: makeRequest({ transaction: undefined }) },
      policyPath
    );
    expect(result.proceed).to.equal(false);
    expect(
      result.results.find((row) => row.id === "transaction-matches-intent")
        ?.status
    ).to.equal("UNVERIFIED");
    expect(readerCalls).to.deep.equal([]);
  });

  it("refuses an undecoded swap before dispatching readers", async () => {
    writeFileSync(policyPath, JSON.stringify(makeSwapPolicy()));
    const result = await handleConsult(
      { request: makeSwapRequest() },
      policyPath
    );
    expect(result.proceed).to.equal(false);
    expect(
      result.results.find((row) => row.id === "transaction-matches-intent")
        ?.status
    ).to.equal("UNVERIFIED");
    expect(readerCalls).to.deep.equal([]);
  });
});
