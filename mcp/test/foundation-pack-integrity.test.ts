import { expect } from "chai";
import { join } from "node:path";

import { assertBuiltinFoundationPack } from "../src/foundation-pack-integrity";
import foundationPack from "../src/knowledge/foundations.json";
import { pinPolicyFile } from "../src/policy";
import { createHedwigServer } from "../src/server-core";

function withBuiltinPack<T>(pack: unknown, run: () => T): T {
  const packPath = require.resolve("../src/knowledge/foundations.json");
  const knowledgePath = require.resolve("../src/knowledge");
  const packModule = require.cache[packPath];
  if (!packModule) throw new Error("expected imported built-in pack");
  const originalPack = packModule.exports;
  const originalKnowledge = require.cache[knowledgePath];
  packModule.exports = pack;
  delete require.cache[knowledgePath];
  try {
    return run();
  } finally {
    packModule.exports = originalPack;
    if (originalKnowledge) require.cache[knowledgePath] = originalKnowledge;
    else delete require.cache[knowledgePath];
  }
}

describe("built-in foundation pack integrity", () => {
  it("normalizes JSON formatting and object keys while retaining reviewed values", () => {
    function reordered(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(reordered);
      if (value === null || typeof value !== "object") return value;
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .reverse()
          .map((key) => [key, reordered(record[key])])
      );
    }
    const reformatted = JSON.parse(
      JSON.stringify(reordered(foundationPack), null, 4).replace(/\n/g, "\r\n")
    );
    expect(() => assertBuiltinFoundationPack(reformatted)).not.to.throw();
  });

  it("rejects altered valid summary text before the foundations server starts", () => {
    const altered = structuredClone(foundationPack);
    altered.sources[0].chunks[0].text += " Changed after source review.";
    let generations = 0;
    withBuiltinPack(altered, () => {
      expect(() =>
        createHedwigServer({
          mode: "education",
          knowledgeMode: "foundations",
          generateFoundations: async () => {
            generations++;
            throw new Error("must not generate");
          },
        })
      ).to.throw("foundation built-in pack integrity mismatch");
    });
    expect(generations).to.equal(0);
  });

  it("rejects format-valid but altered source and license metadata", () => {
    for (const field of [
      "blobSha",
      "licenseBlobSha",
      "contentSha256",
    ] as const) {
      const altered = structuredClone(foundationPack);
      altered.sources[0][field] = "0".repeat(
        field === "contentSha256" ? 64 : 40
      );
      withBuiltinPack(altered, () => {
        expect(() =>
          createHedwigServer({
            mode: "education",
            knowledgeMode: "foundations",
          })
        ).to.throw("foundation built-in pack integrity mismatch");
      });
    }
  });

  it("rejects a structurally valid pack with a source omitted", () => {
    const altered = structuredClone(foundationPack);
    altered.sources.pop();
    withBuiltinPack(altered, () => {
      expect(() =>
        createHedwigServer({
          mode: "education",
          knowledgeMode: "foundations",
        })
      ).to.throw("foundation built-in pack integrity mismatch");
    });
  });

  it("admits the reviewed pack and preserves source attribution", () => {
    withBuiltinPack(structuredClone(foundationPack), () => {
      const { retrieveFoundationSources } = require("../src/knowledge");
      const sources = retrieveFoundationSources("credit delegation allowance");
      expect(
        sources.some(
          (source: { id: string }) =>
            source.id === "aave-v3-credit-delegation-allowance"
        )
      ).to.equal(true);
    });
  });

  it("keeps seed education independent of a mismatched foundations pack", async () => {
    const altered = structuredClone(foundationPack);
    altered.sources[0].chunks[0].text += " Changed after source review.";
    const server = withBuiltinPack(altered, () =>
      createHedwigServer({ mode: "education", knowledgeMode: "seed" })
    );
    await server.close();
  });

  it("keeps consult independent of a mismatched foundations pack", async () => {
    const altered = structuredClone(foundationPack);
    altered.sources[0].chunks[0].text += " Changed after source review.";
    const policyPath = join(__dirname, "fixtures", "policy.json");
    const server = withBuiltinPack(altered, () =>
      createHedwigServer({
        mode: "consult",
        knowledgeMode: "foundations",
        policyPath,
        policyPin: pinPolicyFile(policyPath),
      })
    );
    await server.close();
  });
});
