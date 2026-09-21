import { expect } from "chai";

import { consult } from "../src";
import { ASSET_ADDRESS, makePolicy, makeRequest } from "./fixtures";

const OTHER_WELL_FORMED_ADDRESS = "0x" + "1".repeat(40);

describe("target-is-canonical", () => {
  it("a clean pay request targets the canonical asset contract and passes", () => {
    const response = consult(makeRequest(), makePolicy());
    const result = response.results.find((r) => r.id === "target-is-canonical");
    expect(result?.status).to.equal("PASS");
    expect(result?.code).to.equal("TARGET_IS_CANONICAL");
  });

  it("any other target denies the whole request, whatever else is clean", () => {
    const request = makeRequest({
      action: { ...makeRequest().action, target: OTHER_WELL_FORMED_ADDRESS },
    });
    const response = consult(request, makePolicy());

    expect(response.verdict).to.equal("DENY");
    expect(response.proceed).to.equal(false);
    expect(response.support).to.equal(0);
    expect(response.band).to.equal("red");
    const result = response.results.find((r) => r.id === "target-is-canonical");
    expect(result?.status).to.equal("FAIL");
    expect(result?.code).to.equal("TARGET_NOT_CANONICAL");
  });

  it("a missing target is UNVERIFIED, not a crash and not ALLOW", () => {
    const { target, ...actionWithoutTarget } = makeRequest()
      .action as unknown as Record<string, unknown>;
    const response = consult(
      { action: actionWithoutTarget } as never,
      makePolicy()
    );
    const result = response.results.find((r) => r.id === "target-is-canonical");
    expect(result?.status).to.equal("UNVERIFIED");
    expect(result?.code).to.equal("TARGET_SHAPE_INVALID");
    expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
  });

  it("a malformed target is UNVERIFIED", () => {
    const request = makeRequest({
      action: { ...makeRequest().action, target: "not-an-address" },
    });
    const response = consult(request, makePolicy());
    const result = response.results.find((r) => r.id === "target-is-canonical");
    expect(result?.status).to.equal("UNVERIFIED");
    expect(result?.code).to.equal("TARGET_SHAPE_INVALID");
  });

  it("a non-eip155 chain is UNVERIFIED for target-is-canonical, as the other address Conditions are", () => {
    const request = makeRequest({
      action: { ...makeRequest().action, chainId: "solana:mainnet" },
    });
    const response = consult(
      request,
      makePolicy({ chainId: "solana:mainnet" })
    );
    const result = response.results.find((r) => r.id === "target-is-canonical");
    expect(result?.status).to.equal("UNVERIFIED");
    expect(result?.code).to.equal("TARGET_CHAIN_UNSUPPORTED");
  });

  it("a case-folded canonical target still passes", () => {
    const request = makeRequest({
      action: { ...makeRequest().action, target: ASSET_ADDRESS.toLowerCase() },
    });
    const response = consult(request, makePolicy());
    const result = response.results.find((r) => r.id === "target-is-canonical");
    expect(result?.status).to.equal("PASS");
  });
});
