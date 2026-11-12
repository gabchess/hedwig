import { expect } from "chai";

import { prepareExpertRequest } from "../src/expert-workflow";
import { retrieveFoundationSources } from "../src/knowledge";
import finalHoldout from "./fixtures/expert-final-holdout-eval.json";

describe("delegated borrowing evidence retrieval", () => {
  it("retrieves allowance, debt-owner validation and capacity checks within the existing comparison budget", () => {
    const originalCase = finalHoldout.cases.find(
      ({ id }) => id === "fh04-helper-permission-is-not-unsecured-credit"
    );
    if (!originalCase) throw new Error("missing original delegation question");
    const prepared = prepareExpertRequest(
      { ...originalCase.arguments, question: originalCase.question },
      retrieveFoundationSources
    );
    if (prepared.status !== "ready" || prepared.mode !== "compare") {
      throw new Error("expected a prepared comparison");
    }

    const aaveIds =
      prepared.comparisonEvidence.byDeployment["aave-v3-ethereum"];
    expect(aaveIds).to.include.members([
      "aave-v3-ethereum-identity",
      "aave-v3-supply-borrow-withdraw",
      "aave-v3-delegated-borrow-sequence",
      "aave-v3-credit-delegation-allowance",
      "aave-v3-borrow-capacity-checks",
    ]);
    expect(aaveIds).to.have.length.at.most(7);
    expect(prepared.sources).to.have.length.at.most(16);
    expect(prepared.comparison.liveStateVerified).to.equal(false);
    expect(
      prepared.comparisonEvidence.byDeployment["compound-iii-ethereum-usdc"]
    ).to.include("compound-iii-ethereum-usdc-identity");

    const revision =
      "aave-dao/aave-v3-origin@8305565ae342f1773c42cd2e4593f175fe5968a0";
    const paths = [
      ["aave-v3-delegated-borrow-sequence", "libraries/logic/BorrowLogic.sol"],
      [
        "aave-v3-credit-delegation-allowance",
        "tokenization/VariableDebtToken.sol",
      ],
      ["aave-v3-borrow-capacity-checks", "libraries/logic/ValidationLogic.sol"],
    ];
    for (const [id, sourcePath] of paths) {
      const source = prepared.sources.find((item) => item.id === id);
      expect(source?.revision, id).to.equal(revision);
      expect(source?.sourceFileUrl, id).to.equal(
        "https://github.com/aave-dao/aave-v3-origin/blob/" +
          "8305565ae342f1773c42cd2e4593f175fe5968a0/src/contracts/protocol/" +
          sourcePath
      );
    }
  });
});
