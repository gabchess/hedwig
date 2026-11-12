import { expect } from "chai";

import { prepareExpertRequest } from "../src/expert-workflow";
import { retrieveFoundationSources } from "../src/knowledge";
import foundationPack from "../src/knowledge/foundations.json";
import expertReview from "./fixtures/expert-review-v2-eval.json";

const eligibilityId = "aave-v3-reserve-borrow-eligibility";
const validationUrl =
  "https://github.com/aave-dao/aave-v3-origin/blob/" +
  "8305565ae342f1773c42cd2e4593f175fe5968a0/" +
  "src/contracts/protocol/libraries/logic/ValidationLogic.sol";

describe("reserve borrowing-eligibility evidence", () => {
  it("includes the separate eligibility rule in the original market comparison without enlarging its budget", () => {
    const original = expertReview.cases.find(
      ({ id }) => id === "c01-market-asset-architecture"
    );
    if (!original) throw new Error("missing original market comparison");
    const prepared = prepareExpertRequest(
      { question: original.question, ...original.arguments },
      retrieveFoundationSources
    );
    if (prepared.status !== "ready" || prepared.mode !== "compare") {
      throw new Error("expected a prepared comparison");
    }

    expect(prepared.sources.map(({ id }) => id)).to.include.members([
      ...original.requiredSourceIds,
      eligibilityId,
    ]);
    expect(
      prepared.comparisonEvidence.byDeployment["aave-v3-ethereum"]
    ).to.include(eligibilityId);
    for (const ids of Object.values(prepared.comparisonEvidence.byDeployment)) {
      expect(ids).to.have.length.at.most(7);
    }
    expect(prepared.sources).to.have.length.at.most(16);
    expect(prepared.comparison.liveStateVerified).to.equal(false);

    const source = foundationPack.sources.find(
      ({ sourceId }) => sourceId === "aave-validation-logic"
    );
    const unit = source?.chunks.find(({ id }) => id === eligibilityId);
    const selected = prepared.sources.find(({ id }) => id === eligibilityId);
    expect(unit, "complete reviewed eligibility unit").not.to.equal(undefined);
    expect(selected?.text).to.equal(unit?.text);
    expect(selected?.sourceFileUrl).to.equal(validationUrl);
    expect(selected?.revision).to.equal(
      "aave-dao/aave-v3-origin@8305565ae342f1773c42cd2e4593f175fe5968a0"
    );
    expect(
      prepared.comparisonEvidence.byDeployment["compound-iii-ethereum-usdc"]
    ).not.to.include(eligibilityId);
  });

  it("retrieves the complete rule for independent supply-support and eMode questions", () => {
    for (const question of [
      "Does supporting a reserve for supply make it borrowable in Aave V3?",
      "How do the reserve borrowing flag and eMode category affect which Aave assets may be borrowed?",
      "In an Aave market, can a supplied asset be unavailable for borrowing?",
      "Quais reservas podem ser emprestadas no Aave V3 e como o eMode afeta essa permissão?",
    ]) {
      const selected = retrieveFoundationSources(question, {
        topics: ["Aave V3"],
        limit: 6,
      });
      expect(
        selected.map(({ id }) => id),
        question
      ).to.include(eligibilityId);
      expect(selected).to.have.length.at.most(6);
      expect(
        selected.find(({ id }) => id === eligibilityId)?.sourceFileUrl
      ).to.equal(validationUrl);
    }
  });

  it("keeps the Aave eligibility rule outside a Compound-only mechanism scope", () => {
    const selected = retrieveFoundationSources(
      "Which supported reserve assets can be borrowed?",
      { topics: ["Compound III"], limit: 6 }
    );
    expect(selected).not.to.have.length(0);
    expect(selected.map(({ id }) => id)).not.to.include(eligibilityId);
  });
});
