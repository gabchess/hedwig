import { expect } from "chai";
import { prepareExpertRequest } from "../src/expert-workflow";
import { retrieveFoundationSources } from "../src/knowledge";
import foundationPack from "../src/knowledge/foundations.json";
import expertReview from "./fixtures/expert-review-v2-eval.json";

describe("complete x402 role evidence", () => {
  const unitId = "x402-v2-roles-and-facilitator";
  it("provides a complete role unit for the original question and independent role wording", () => {
    const original = expertReview.cases.find(
      ({ id }) => id === "g09-x402-role-boundaries"
    );
    if (!original) throw new Error("missing original role case");
    const source = foundationPack.sources.find(
      ({ sourceId }) => sourceId === "x402-v2-spec"
    );
    const unit = source?.chunks.find(({ id }) => id === unitId);
    if (!unit || !source) throw new Error("missing complete role unit");
    for (const question of [
      original.question,
      "In x402, what does each client, server and facilitator do?",
      "Who controls protected-resource access and who prepares the payment in x402?",
    ]) {
      const prepared = prepareExpertRequest(
        { question },
        retrieveFoundationSources
      );
      if (prepared.status !== "ready")
        throw new Error("expected supported role preparation");
      expect(prepared.sources).to.have.length.at.most(9);
      const role = prepared.sources.find(({ id }) => id === unitId);
      expect(role?.text).to.equal(unit.text);
      expect(role?.sourceFileUrl).to.equal(source.sourceFileUrl);
      expect(role?.revision).to.equal(source.revision);
      expect(role?.text).to.include(
        "in the default authorization flow it submits a signed payment authorization"
      );
      expect(role?.text).to.include("gates access to the protected resource");
      expect(role?.text).to.include(
        "pre-resource verification or settlement check"
      );
      expect(role?.text).to.include(
        "delegate those endpoints to a trusted third party or host them itself"
      );
    }
    expect(unit.sections).to.deep.include.members([
      {
        heading: "2. Core Payment Flow",
        anchor: "#2-core-payment-flow",
        lineStart: 36,
        lineEnd: 45,
      },
      {
        heading: "6.1 Asset Transfer Methods and Payment Flow Models",
        anchor: "#61-asset-transfer-methods-and-payment-flow-models",
        lineStart: 285,
        lineEnd: 301,
      },
    ]);
  });
  it("keeps flow-specific evidence available rather than making verification universal", () => {
    for (const question of [
      "How does x402 default authorization order verification, serving the resource and settlement?",
      "Do upfront and escrow payment flows require read-only verify before serving a resource?",
    ]) {
      const sources = retrieveFoundationSources(question, { limit: 9 });
      expect(sources.map(({ id }) => id)).to.include.members([
        unitId,
        "x402-verification-settlement",
      ]);
      const flow = sources.find(
        ({ id }) => id === "x402-verification-settlement"
      );
      expect(flow?.text).to.include(
        "Upfront and escrow flows use different orderings and omit verify"
      );
    }
  });
});
