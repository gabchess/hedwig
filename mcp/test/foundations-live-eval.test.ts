import { expect } from "chai";

const { qualifyZeroPricing, retrievalMatches, statusSummary } =
  require("./foundations-live-eval") as {
    qualifyZeroPricing: (
      payload: unknown,
      model: string
    ) => { prompt: string; completion: string; request?: string };
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
  it("accepts the observed free catalog shape without a request price", () => {
    const model = "baidu/ernie-5.5-flash-preview:free";
    const payload = {
      data: [{ id: model, pricing: { prompt: "0", completion: "0" } }],
    };

    expect(qualifyZeroPricing(payload, model)).to.deep.equal({
      prompt: "0",
      completion: "0",
    });
  });

  it("requires zero token prices and rejects a nonzero request price", () => {
    const model = "baidu/ernie-5.5-flash-preview:free";
    const catalog = (pricing: Record<string, string>) => ({
      data: [{ id: model, pricing }],
    });

    expect(() =>
      qualifyZeroPricing(catalog({ completion: "0" }), model)
    ).to.throw();
    expect(() =>
      qualifyZeroPricing(
        catalog({ prompt: "0", completion: "0", request: "0.001" }),
        model
      )
    ).to.throw();
    expect(
      qualifyZeroPricing(
        catalog({ prompt: "0", completion: "0", request: "0" }),
        model
      )
    ).to.deep.equal({ prompt: "0", completion: "0", request: "0" });
  });

  it("requires the exact selected catalog model", () => {
    const payload = {
      data: [
        {
          id: "baidu/ernie-5.5-flash-preview:free",
          pricing: { prompt: "0", completion: "0" },
        },
      ],
    };

    expect(() =>
      qualifyZeroPricing(payload, "baidu/ernie-5.5-flash-preview")
    ).to.throw();
  });

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
