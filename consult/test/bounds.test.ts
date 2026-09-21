import { expect } from "chai";

import { consult } from "../src";
import { makePolicy, makeRequest } from "./fixtures";

describe("consult bounds", () => {
  it("refuses an input whose size cannot be measured", () => {
    // JSON.stringify throws on a BigInt, so the size check cannot run.
    const request = { ...makeRequest(), memo: "x".repeat(1_000_000), n: 1n };

    const response = consult(request as never, makePolicy());

    expect(response.verdict).to.equal("UNKNOWN");
  });

  it("caps how many extra conditions a request can name", () => {
    // Short ids keep the request under the input size limit, so only the
    // conditions cap can stop it.
    const conditions = Array.from({ length: 5000 }, (_, i) => `m${i}`);
    const request = { ...makeRequest(), conditions };

    const response = consult(request, makePolicy());

    expect(response.verdict).to.equal("UNKNOWN");
    expect(response.results.length).to.be.lessThan(20);
    expect(JSON.stringify(response).length).to.be.lessThan(8 * 1024);
  });

  it("never echoes an oversized condition id back as a result id", () => {
    const request = { ...makeRequest(), conditions: ["x".repeat(60_000)] };

    const response = consult(request, makePolicy());

    expect(response.verdict).to.equal("UNKNOWN");
    response.results.forEach((result) => {
      expect(result.id.length).to.be.at.most(64);
    });
  });
});
