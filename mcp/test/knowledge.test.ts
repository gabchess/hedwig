import { expect } from "chai";

import expertReview from "./fixtures/expert-review-v2-eval.json";

import {
  buildFoundationRetriever,
  retrieveFoundationSources,
  type FoundationSource,
} from "../src/knowledge";

const HELD_OUT: Array<[string, string[]]> = [
  [
    "What’s the difference between an EOA and a contract account?",
    ["ethereum-accounts-model"],
  ],
  [
    "Can a contract account start a transaction by itself?",
    ["ethereum-accounts-model"],
  ],
  [
    "What information does Ethereum store for each account?",
    ["ethereum-account-state"],
  ],
  [
    "What is the smallest unit of ether, and what is gwei used for?",
    ["ethereum-ether-denominations"],
  ],
  [
    "Qual ativo o campo balance representa e em qual unidade o saldo e expresso?",
    ["ethereum-account-state", "ethereum-ether-denominations"],
  ],
  [
    "How is a transaction different from a message sent during contract execution?",
    ["ethereum-transaction-model"],
  ],
  [
    "Why does an Ethereum transaction include a nonce and gas limit?",
    ["ethereum-transaction-fields"],
  ],
  [
    "What must happen before a transaction changes Ethereum state?",
    ["ethereum-transaction-model"],
  ],
  [
    "When would someone use ERC-4626 deposit instead of mint?",
    ["erc4626-operations"],
  ],
  ["How is withdraw different from redeem?", ["erc4626-operations"]],
  [
    "How does previewDeposit differ from a direct asset-to-share conversion?",
    ["erc4626-conversions-and-previews"],
  ],
  [
    "What happens when an x402 client requests a resource that requires payment?",
    ["x402-v2-request-flow"],
  ],
  [
    "What does the facilitator do in x402 v2?",
    ["x402-v2-roles-and-facilitator"],
  ],
  [
    "What messages pass between the client and server during x402 payment?",
    ["x402-v2-request-flow", "x402-v2-roles-and-facilitator"],
  ],
];

function fixturePack(chunks: Array<{ id: string; text: string }>) {
  return {
    schemaVersion: 1,
    sources: [
      {
        sourceId: "fixture-source",
        title: "Fixture source",
        url: "https://example.test/source",
        sourceFileUrl:
          "https://github.com/example/source/blob/0123456789abcdef0123456789abcdef01234567/source.md",
        revision: "example/source@0123456789abcdef0123456789abcdef01234567",
        blobSha: "1111111111111111111111111111111111111111",
        license: "MIT",
        licenseUrl:
          "https://github.com/example/source/blob/0123456789abcdef0123456789abcdef01234567/LICENSE",
        licenseBlobSha: "2222222222222222222222222222222222222222",
        chunks: chunks.map(({ id, text }) => ({
          id,
          topics: [],
          keywords: [],
          sections: [],
          text,
        })),
      },
    ],
  };
}

describe("foundation BM25 retrieval", () => {
  it("retrieves every held-out target chunk without depending on rank", () => {
    for (const [question, targetIds] of HELD_OUT) {
      const results = retrieveFoundationSources(question);
      const resultIds = results.map(({ id }) => id);
      for (const targetId of targetIds) {
        expect(resultIds, question).to.include(targetId);
      }
    }
  });

  it("normalizes EOA, ETH/ether, and ERC-4626 spellings", () => {
    expect(
      retrieveFoundationSources("Can an EOA begin an ether payment?").map(
        ({ id }) => id
      )
    ).to.include("ethereum-accounts-model");
    expect(
      retrieveFoundationSources("What do ERC 4626 vault shares represent?").map(
        ({ id }) => id
      )
    ).to.include("erc4626-shares-and-assets");
    expect(
      retrieveFoundationSources("What is an ERC4626 vault?").map(({ id }) => id)
    ).to.include("erc4626-shares-and-assets");
  });

  it("keeps aToken identity distinct from generic token wording across case and plural forms", () => {
    const retrieve = buildFoundationRetriever(
      fixturePack([
        { id: "generic-token", text: "A generic token identifies an asset." },
        { id: "interest-receipt", text: "An aToken balance accrues interest." },
      ])
    );
    for (const term of [
      "aToken",
      "atoken",
      "AToken",
      "ATOKEN",
      "aTokens",
      "atokens",
      "ATOKENS",
    ]) {
      expect(
        retrieve(term).map(({ id }) => id),
        term
      ).to.deep.equal(["interest-receipt"]);
    }
    for (const term of ["token", "a token"]) {
      expect(
        retrieve(term).map(({ id }) => id),
        term
      ).to.deep.equal(["generic-token"]);
    }
    expect(retrieve("datoken")).to.deep.equal([]);
  });

  it("retrieves aToken accrual for English and Portuguese mechanism questions", () => {
    for (const question of [
      "How does interest accrue to an aToken supply position?",
      "How does interest accrue to ATOKENS?",
      "Como um atoken registra juros?",
      "Por que o saldo de aTokens pode aumentar com juros?",
      "How is an aToken different from a generic token?",
    ]) {
      expect(
        retrieveFoundationSources(question).map(({ id }) => id),
        question
      ).to.include("aave-v3-atoken-accrual");
    }
  });

  it("preserves eMode identity across case variants without matching an ordinary mode", () => {
    const retrieve = buildFoundationRetriever(
      fixturePack([
        { id: "efficiency-category", text: "An eMode category." },
        { id: "ordinary-mode", text: "An ordinary operating mode." },
      ])
    );
    for (const term of ["eMode", "emode", "EMode", "EMODE", "EmOdE"]) {
      expect(
        retrieve(term).map(({ id }) => id),
        term
      ).to.deep.equal(["efficiency-category"]);
    }
    expect(retrieve("mode").map(({ id }) => id)).to.deep.equal([
      "ordinary-mode",
    ]);
    expect(retrieve("demode")).to.deep.equal([]);
  });

  it("does not match eMode evidence through the Portuguese conjunction e", () => {
    const retrieve = buildFoundationRetriever(
      fixturePack([
        { id: "efficiency-category", text: "An eMode category." },
        { id: "portuguese-balance", text: "balance e unidade" },
      ])
    );
    for (const question of ["e", "balance e unidade"]) {
      expect(
        retrieve(question).map(({ id }) => id),
        question
      ).to.deep.equal(["portuguese-balance"]);
    }
  });

  it("meets the unchanged mixed-yield evidence contract within nine sources", () => {
    const regression = expertReview.cases.find(
      ({ id }) => id === "f09-portuguese-mixed-yield"
    );
    if (!regression?.requiredSourceAlternatives) {
      throw new Error("mixed-yield evidence contract is missing");
    }
    const sources = retrieveFoundationSources(regression.question, {
      limit: 9,
    });
    const ids = sources.map(({ id }) => id);
    expect(ids).to.have.length.at.most(9);
    expect(ids).to.include.members(regression.requiredSourceIds);
    expect(
      regression.requiredSourceAlternatives.some((alternative) =>
        alternative.every((id) => ids.includes(id))
      )
    ).to.equal(true);
  });

  it("returns no candidates for empty, stopword-only, unrelated, and oversized input", () => {
    for (const question of [
      "",
      "  ",
      "what is and the",
      "blorf quux zarg",
      "constructor",
      "toString",
      "__proto__",
      "x".repeat(4001),
      null,
      7,
    ]) {
      expect(
        retrieveFoundationSources(question as never),
        String(question).slice(0, 30)
      ).to.deep.equal([]);
    }
  });

  it("bounds results to five chunks", () => {
    const results = retrieveFoundationSources(
      "Ethereum account transaction ERC-4626 vault shares x402 facilitator"
    );
    expect(results.length).to.be.at.most(5);
  });

  it("sorts exact score ties by ordinal chunk id across locales", () => {
    const retrieve = buildFoundationRetriever(
      fixturePack([
        { id: "tie-B", text: "alpha beta evidence" },
        { id: "tie-a", text: "alpha beta evidence" },
      ])
    );
    const first = retrieve("alpha beta").map(({ id }) => id);
    const second = retrieve("alpha beta").map(({ id }) => id);
    expect(first).to.deep.equal(["tie-B", "tie-a"]);
    expect(second).to.deep.equal(first);
  });

  it("preserves pinned source metadata with each retrieved chunk", () => {
    const source: FoundationSource | undefined = retrieveFoundationSources(
      "What does the facilitator do in x402 v2?"
    ).find(({ id }) => id === "x402-v2-roles-and-facilitator");
    expect(source).to.include({
      id: "x402-v2-roles-and-facilitator",
      url: "https://github.com/x402-foundation/x402/blob/4f674517cee0bd3c4ef9c7be2b09f16b3efaaa7f/specs/x402-specification-v2.md",
      sourceFileUrl:
        "https://github.com/x402-foundation/x402/blob/4f674517cee0bd3c4ef9c7be2b09f16b3efaaa7f/specs/x402-specification-v2.md",
      revision: "x402-foundation/x402@4f674517cee0bd3c4ef9c7be2b09f16b3efaaa7f",
      title: "x402 Protocol Specification, Version 2",
    });
    expect(source?.text).to.be.a("string").and.not.empty;
  });

  it("rejects duplicate chunk ids and missing or unpinned provenance", () => {
    const duplicate = fixturePack([
      { id: "same", text: "alpha evidence" },
      { id: "same", text: "beta evidence" },
    ]);
    expect(() => buildFoundationRetriever(duplicate)).to.throw(/duplicate/i);

    const missingRevision = fixturePack([
      { id: "valid", text: "alpha evidence" },
    ]);
    delete (missingRevision.sources[0] as { revision?: string }).revision;
    expect(() => buildFoundationRetriever(missingRevision)).to.throw(
      /revision/i
    );

    const missingLicense = fixturePack([
      { id: "valid", text: "alpha evidence" },
    ]);
    delete (missingLicense.sources[0] as { license?: string }).license;
    expect(() => buildFoundationRetriever(missingLicense)).to.throw(/license/i);

    const unpinnedUrl = fixturePack([{ id: "valid", text: "alpha evidence" }]);
    (unpinnedUrl.sources[0] as { sourceFileUrl: string }).sourceFileUrl =
      "https://github.com/example/source/blob/main/source.md";
    expect(() => buildFoundationRetriever(unpinnedUrl)).to.throw(/pinned/i);

    const missingSourceUrl = fixturePack([
      { id: "valid", text: "alpha evidence" },
    ]);
    delete (missingSourceUrl.sources[0] as { sourceFileUrl?: string })
      .sourceFileUrl;
    expect(() => buildFoundationRetriever(missingSourceUrl)).to.throw(
      /sourceFileUrl/i
    );

    const unpinnedLicenseUrl = fixturePack([
      { id: "valid", text: "alpha evidence" },
    ]);
    (unpinnedLicenseUrl.sources[0] as { licenseUrl: string }).licenseUrl =
      "https://github.com/example/source/blob/main/LICENSE";
    expect(() => buildFoundationRetriever(unpinnedLicenseUrl)).to.throw(
      /pinned/i
    );
  });

  it("requires the repository and revision in the source and license URL path", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    for (const field of ["sourceFileUrl", "licenseUrl"] as const) {
      for (const invalid of [
        `https://github.com/example/source/blob/main/source.md?ref=/${commit}/`,
        `https://github.com/example/source/blob/main/source.md#/${commit}/`,
        `https://github.com/example/source/blob/main/${commit}/source.md`,
        `https://github.com/other/repo/blob/${commit}/source.md`,
        `https://github.com.invalid/example/source/blob/${commit}/source.md`,
        `https://raw.githubusercontent.com/example/source/main/source.md?ref=/${commit}/`,
      ]) {
        const pack = fixturePack([{ id: "valid", text: "alpha evidence" }]);
        pack.sources[0][field] = invalid;
        expect(
          () => buildFoundationRetriever(pack),
          `${field}: ${invalid}`
        ).to.throw(/pinned/i);
      }
      for (const valid of [
        `https://github.com/example/source/blob/${commit}/source.md#section`,
        `https://raw.githubusercontent.com/example/source/${commit}/source.md`,
      ]) {
        const pack = fixturePack([{ id: "valid", text: "alpha evidence" }]);
        pack.sources[0][field] = valid;
        expect(() => buildFoundationRetriever(pack)).not.to.throw();
      }
    }
  });

  it("rejects duplicate source ids", () => {
    const pack = fixturePack([{ id: "first", text: "alpha evidence" }]);
    pack.sources.push({
      ...pack.sources[0],
      chunks: [
        {
          id: "second",
          topics: [],
          keywords: [],
          sections: [],
          text: "beta evidence",
        },
      ],
    });
    expect(() => buildFoundationRetriever(pack)).to.throw(
      /duplicate.*source id/i
    );
  });
});
