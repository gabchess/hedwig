import { expect } from "chai";

const { retrievalMatches, statusSummary } =
  require("./foundations-live-eval") as {
    retrievalMatches: (
      requiredIds: string[],
      retrievedIds: string[]
    ) => boolean | null;
    statusSummary: (cases: Array<{ statusMatched: boolean }>) => {
      statusMatchCount: number;
      statusCheckPassed: boolean;
    };
  };

describe("foundations live eval helpers", () => {
  it("leaves retrieval unscored when a fixture has no required IDs", () => {
    expect(retrievalMatches([], ["candidate-a"])).to.equal(null);
  });

  it("checks only required retrieval IDs", () => {
    expect(retrievalMatches(["required-a"], ["required-a", "extra"])).to.equal(
      true
    );
    expect(retrievalMatches(["required-a"], ["extra"])).to.equal(false);
  });

  it("fails the status check when any expected status differs", () => {
    expect(
      statusSummary([{ statusMatched: true }, { statusMatched: false }])
    ).to.deep.equal({ statusMatchCount: 1, statusCheckPassed: false });
  });
});
