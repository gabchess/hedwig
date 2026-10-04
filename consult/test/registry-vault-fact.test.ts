import { expect } from "chai";

import { consult } from "../src";
import type { Facts, RegistryVaultFact } from "../src";
import { makePolicy, makeRequest } from "./fixtures";

// The vault Fact is a type and a field in this change: no Condition reads
// it yet. This pins that the field is accepted as a Fact, that a Fact of
// either upgradeable kind fits the type, and that carrying one changes no
// answer.

const NOW = 2_000_000_000;
const WORD = "0x" + "0".repeat(64);

const noneVault: RegistryVaultFact = {
  chainId: "eip155:1",
  contractAddress: "0xbeef047a543e45807105e51a8bbefcc5950fcfba",
  asset: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  upgradeable: "none",
  expiresAt: NOW + 86400,
  vaultCodeHash: "match",
  implementationSlot: WORD,
  assetRead: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  preview: { shares: "882612176477205266" },
  blockNumber: 26110209,
  liveReadAt: NOW,
};

const proxyVault: RegistryVaultFact = {
  ...noneVault,
  contractAddress: "0xe2e7a17dff93280dec073c995595155283e3c372",
  upgradeable: "eip1967",
  implementation: {
    address: "0x1b992302652a92611dcd5090d1cb388c6377f455",
    codeSha256: "a".repeat(64),
  },
  implementationSlot: "unread",
  implementationCodeHash: "unread",
  assetRead: "unread",
  preview: { failed: true },
};

describe("Facts.registryVault", () => {
  it("is part of the Facts type for both row kinds", () => {
    const facts: Facts = { now: NOW, registryVault: noneVault };
    const proxy: Facts = { now: NOW, registryVault: proxyVault };
    expect(facts.registryVault?.upgradeable).to.equal("none");
    expect(proxy.registryVault?.implementation?.address).to.match(/^0x/);
  });

  it("changes no answer until a Condition reads it", () => {
    const request = makeRequest();
    const policy = makePolicy();
    const without = consult(request, policy, { now: NOW });
    expect(
      consult(request, policy, { now: NOW, registryVault: noneVault })
    ).to.deep.equal(without);
    expect(
      consult(request, policy, { now: NOW, registryVault: proxyVault })
    ).to.deep.equal(without);
  });
});
