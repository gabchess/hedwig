import { expect } from "chai";

import { consult } from "../src";
import { makePolicy, makeRequest } from "./fixtures";

const RANK: Record<string, number> = { FAIL: 0, UNVERIFIED: 1, PASS: 2 };

describe("results ordering", () => {
  it("sorts FAIL, then UNVERIFIED, then PASS, and floorIds keeps catalog order", () => {
    // recipient-matches-policy: FAIL (unapproved but well-formed).
    // asset-is-canonical: UNVERIFIED (unknown symbol).
    // Every other Floor Condition still runs and PASSes or fails on its own
    // terms; this only needs at least one of each rank to prove the order.
    const request = makeRequest({
      action: {
        ...makeRequest().action,
        recipient: "0x00000000000000000000000000000000badc0de0",
        asset: {
          symbol: "USDT",
          contractAddress: makeRequest().action.asset.contractAddress,
        },
      },
    });
    const response = consult(request, makePolicy());

    const ranks = response.results.map((r) => RANK[r.status]);
    const sorted = [...ranks].sort((a, b) => a - b);
    expect(ranks).to.deep.equal(sorted);
    expect(response.results.some((r) => r.status === "FAIL")).to.equal(true);
    expect(response.results.some((r) => r.status === "UNVERIFIED")).to.equal(
      true
    );

    // floorIds is unaffected by the results sort: it stays catalog order.
    expect(response.floorIds).to.deep.equal([
      "recipient-matches-policy",
      "recipient-not-poison-derived",
      "asset-is-canonical",
      "amount-within-cap",
      "chain-matches-intent",
      "target-is-canonical",
    ]);
  });

  it("keeps catalog order stable within a status group on a clean pass", () => {
    const response = consult(makeRequest(), makePolicy());
    const ids = response.results.map((r) => r.id);
    expect(ids).to.deep.equal(response.floorIds as unknown as string[]);
  });
});
