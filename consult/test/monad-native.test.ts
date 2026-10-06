import { expect } from "chai";
import { consult } from "../src";
import { runTriggerGuard } from "../src/guard";
import { makeSwapPolicy, makeSwapRequest, SWAP_NOW } from "./fixtures";

const usdc = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const incorrect = "0x" + "7".repeat(40);
const issuerUrl =
  "https://developers.circle.com/stablecoins/usdc-contract-addresses";
const issuerSource = {
  origin: "circle.com",
  url: issuerUrl,
  retrievedAt: SWAP_NOW - 3600,
};

const request = (address = usdc) =>
  makeSwapRequest({
    action: {
      ...makeSwapRequest().action,
      chainId: "eip155:143",
      tokenIn: { kind: "native", symbol: "MON" },
      tokenOut: { symbol: "USDC", contractAddress: address },
    },
  });
const policy = makeSwapPolicy({ chainId: "eip155:143" });
const facts = (
  source: unknown = issuerSource,
  patch: Record<string, unknown> = {}
) => ({
  now: SWAP_NOW,
  registryAsset: {
    chainId: "eip155:143",
    symbol: "USDC",
    contractAddress: usdc,
    expiresAt: SWAP_NOW + 86400,
    liveRead: "confirmed",
    liveReadAt: SWAP_NOW,
    issuerSource: source,
    ...patch,
  },
});

describe("native Monad output check", () => {
  it("a wrong output address denies with the verified address and issuer source", () => {
    const result = consult(request(incorrect), policy, facts());
    const output = result.results.find(
      (row) => row.id === "token-out-is-canonical"
    )!;
    expect(output.status).to.equal("FAIL");
    expect(output).to.have.property("canonicalAsset").that.deep.equals({
      chainId: "eip155:143",
      symbol: "USDC",
      contractAddress: usdc,
      issuerSource,
    });
    expect(output.evidence.length).to.be.at.most(123);
    expect(result.verdict).to.equal("DENY");
    expect(result.support).to.equal(0);
    expect(result.proceed).to.equal(false);
    expect(Object.isFrozen(output.canonicalAsset)).to.equal(true);
    expect(Object.isFrozen(output.canonicalAsset?.issuerSource)).to.equal(true);
  });

  it("a matching output proves token identity while native execution stays blocked", () => {
    const result = consult(request(), policy, facts());
    const output = result.results.find(
      (row) => row.id === "token-out-is-canonical"
    )!;
    expect(output.status).to.equal("PASS");
    expect(output).to.have.property("canonicalAsset").that.deep.equals({
      chainId: "eip155:143",
      symbol: "USDC",
      contractAddress: usdc,
      issuerSource,
    });
    expect(
      result.results.find((row) => row.id === "token-in-is-canonical")?.status
    ).to.equal("UNVERIFIED");
    // Legacy checklist support is separate from the future safety score.
    expect(result.proceed).to.equal(false);
  });

  for (const [name, source] of [
    ["missing", undefined],
    ["wrong issuer", { ...issuerSource, origin: "attacker.test" }],
    ["hostile URL", { ...issuerSource, url: "javascript:alert(1)" }],
    ["future time", { ...issuerSource, retrievedAt: SWAP_NOW + 1 }],
    ["non-integer time", { ...issuerSource, retrievedAt: SWAP_NOW - 0.5 }],
  ] as const) {
    it(`${name} issuer evidence cannot prove native output identity`, () => {
      const inputFacts = facts(source);
      if (source === undefined)
        delete (inputFacts.registryAsset as Record<string, unknown>)
          .issuerSource;
      const result = consult(request(), policy, inputFacts);
      expect(
        result.results.find((row) => row.id === "token-out-is-canonical")
          ?.status
      ).to.equal("UNVERIFIED");
      expect(result.proceed).to.equal(false);
    });
  }

  it("a hybrid native/contract input remains unverified even with a matching MON fact", () => {
    const hybrid = request();
    hybrid.action.tokenIn = {
      kind: "native",
      symbol: "MON",
      contractAddress: incorrect,
    } as never;
    const result = consult(
      hybrid,
      policy,
      facts(undefined, { symbol: "MON", contractAddress: incorrect })
    );
    expect(
      result.results.find((row) => row.id === "token-in-is-canonical")?.status
    ).to.equal("UNVERIFIED");
    expect(result.proceed).to.equal(false);
  });

  it("expired or unconfirmed output facts never authorize native execution", () => {
    for (const patch of [
      { expiresAt: SWAP_NOW },
      { liveRead: "unconfirmed" },
    ]) {
      const result = consult(request(), policy, facts(issuerSource, patch));
      expect(
        result.results.find((row) => row.id === "token-out-is-canonical")
          ?.status
      ).to.equal("UNVERIFIED");
      expect(result.proceed).to.equal(false);
    }
  });

  it("neither wrong nor matching output reaches the guard's signer", async () => {
    for (const address of [incorrect, usdc]) {
      let signerCalls = 0;
      const result = await runTriggerGuard({
        payment: request(address),
        toRequest: (payment) => payment,
        policy,
        gather: () => facts(),
        signer: () => {
          signerCalls++;
          return "signed";
        },
      });
      expect(result.consult.proceed).to.equal(false);
      expect(result.signerOutcome).to.equal("not-attempted");
      expect(signerCalls).to.equal(0);
    }
  });
});
