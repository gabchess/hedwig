import { expect } from "chai";
import {
  buildFoundationRetriever,
  retrieveFoundationSources,
  type FoundationSource,
} from "../src/knowledge";

type Scope = {
  topics?: readonly string[];
  excludeTopics?: readonly string[];
  excludeIds?: readonly string[];
  limit?: number;
};
type ScopedRetriever = (question: string, scope?: Scope) => FoundationSource[];

function pack(chunks: Array<{ id: string; topics: string[]; text: string }>) {
  return {
    schemaVersion: 1,
    sources: [
      {
        sourceId: "fixture",
        title: "Reference notes",
        url: "https://example.test/notes",
        sourceFileUrl:
          "https://github.com/example/notes/blob/" +
          "a".repeat(40) +
          "/notes.md",
        revision: "example/notes@" + "a".repeat(40),
        blobSha: "b".repeat(40),
        license: "MIT",
        licenseUrl:
          "https://github.com/example/notes/blob/" +
          "a".repeat(40) +
          "/LICENSE",
        licenseBlobSha: "c".repeat(40),
        chunks: chunks.map((chunk) => ({ ...chunk, keywords: [] })),
      },
    ],
  };
}

describe("foundation retrieval scopes", () => {
  it("reserves cross-cutting evidence by excluding protocol topics before ranking", () => {
    const retrieve: ScopedRetriever = buildFoundationRetriever(
      pack([
        ...Array.from({ length: 8 }, (_, i) => ({
          id: `protocol-${i}`,
          topics: ["Atlas III"],
          text: "Shared asset issuer control.",
        })),
        {
          id: "issuer",
          topics: ["Stablecoins"],
          text: "Shared asset issuer control.",
        },
        {
          id: "bridge",
          topics: ["Bridges"],
          text: "Shared asset issuer control.",
        },
      ])
    );
    expect(
      retrieve("shared asset issuer", {
        excludeTopics: [" atlas   III "],
        limit: 2,
      }).map((s) => s.id)
    ).to.have.members(["issuer", "bridge"]);
    expect(
      retrieve("shared asset issuer", {
        topics: ["Atlas III"],
        excludeTopics: ["Atlas III"],
      })
    ).to.deep.equal([]);
  });
  it("keeps the five-result default and permits a bounded larger evidence budget", () => {
    const retrieve: ScopedRetriever = buildFoundationRetriever(
      pack(
        Array.from({ length: 12 }, (_, i) => ({
          id: `chunk-${String(i).padStart(2, "0")}`,
          topics: ["Atlas III"],
          text: "Margin rules.",
        }))
      )
    );
    expect(retrieve("margin")).to.have.length(5);
    expect(retrieve("margin", { limit: 6 })).to.have.length(6);
    expect(retrieve("margin", { limit: 9 }).map(({ id }) => id)).to.deep.equal([
      "chunk-00",
      "chunk-01",
      "chunk-02",
      "chunk-03",
      "chunk-04",
      "chunk-05",
      "chunk-06",
      "chunk-07",
      "chunk-08",
    ]);
  });

  it("rejects invalid or excessive limits instead of expanding the context", () => {
    const retrieve: ScopedRetriever = buildFoundationRetriever(
      pack([{ id: "one", topics: ["Atlas III"], text: "Margin rules." }])
    );
    for (const limit of [0, -1, 1.5, 10, Infinity, NaN]) {
      expect(retrieve("margin", { limit }), String(limit)).to.deep.equal([]);
    }
  });

  it("filters before ranking so another topic cannot consume the selected topic's slots", () => {
    const retrieve: ScopedRetriever = buildFoundationRetriever(
      pack([
        {
          id: "atlas-margin",
          topics: ["Atlas III"],
          text: "Collateral margin depends on an oracle price.",
        },
        {
          id: "atlas-withdrawal",
          topics: ["Atlas III"],
          text: "Withdrawal requires sufficient collateral.",
        },
        ...Array.from({ length: 7 }, (_, i) => ({
          id: `other-${i}`,
          topics: ["Borealis"],
          text: "Collateral margin oracle price withdrawal collateral margin oracle price withdrawal.",
        })),
      ])
    );
    const query = "collateral margin oracle price withdrawal";
    const selected = retrieve(query, { topics: ["Atlas III"] }).map(
      ({ id }) => id
    );
    expect(selected).to.have.members(["atlas-margin", "atlas-withdrawal"]);
    expect(retrieve(query).map(({ id }) => id)).to.include("other-0");
  });

  it("matches complete metadata topics case-insensitively without mixing versions", () => {
    const retrieve: ScopedRetriever = buildFoundationRetriever(
      pack([
        { id: "current", topics: ["Atlas III"], text: "Margin rules." },
        { id: "old", topics: ["Atlas II"], text: "Margin rules." },
        { id: "unscoped", topics: [], text: "Atlas III margin rules." },
      ])
    );
    expect(
      retrieve("margin", { topics: ["  ATLAS   iii "] }).map(({ id }) => id)
    ).to.deep.equal(["current"]);
    expect(retrieve("margin", { topics: ["Atlas"] })).to.deep.equal([]);
  });

  it("treats multiple allowed topics as a union and empty or unknown scopes as no evidence", () => {
    const retrieve: ScopedRetriever = buildFoundationRetriever(
      pack([
        { id: "one", topics: ["Atlas III"], text: "Margin rules." },
        { id: "two", topics: ["Borealis"], text: "Margin rules." },
        { id: "three", topics: ["Cygnus"], text: "Margin rules." },
      ])
    );
    expect(
      retrieve("margin", { topics: ["Atlas III", "Borealis"] }).map(
        ({ id }) => id
      )
    ).to.have.members(["one", "two"]);
    expect(retrieve("margin", { topics: [] })).to.deep.equal([]);
    expect(retrieve("margin", { topics: ["unknown"] })).to.deep.equal([]);
  });

  it("excludes reserved chunks before the five-result limit and fills remaining slots", () => {
    const retrieve: ScopedRetriever = buildFoundationRetriever(
      pack([
        { id: "identity", topics: ["Atlas III"], text: "Margin." },
        ...Array.from({ length: 6 }, (_, i) => ({
          id: `mechanism-${i}`,
          topics: ["Atlas III"],
          text: "Margin mechanics explained here.",
        })),
      ])
    );
    expect(retrieve("margin").map(({ id }) => id)).to.include("identity");
    const selected = retrieve("margin", {
      topics: ["Atlas III"],
      excludeIds: ["identity"],
    });
    expect(selected).to.have.length(5);
    expect(selected.map(({ id }) => id)).to.deep.equal([
      "mechanism-0",
      "mechanism-1",
      "mechanism-2",
      "mechanism-3",
      "mechanism-4",
    ]);
    expect(retrieve("unmatched", { topics: ["Atlas III"] })).to.deep.equal([]);
  });

  it("preserves scoping through the bundled-corpus entry point", () => {
    const retrieve: ScopedRetriever = retrieveFoundationSources;
    expect(
      retrieve("Ethereum account", { topics: ["missing topic"] })
    ).to.deep.equal([]);
  });
});
