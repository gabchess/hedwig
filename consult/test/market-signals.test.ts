import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import { assetKnownTo, consult } from "../src";
import { BASE_CHAIN_ID } from "../src/catalog";
import { MAX_MARKET_READING_AGE_SECONDS } from "../src/constants";
import { PARAM_READS } from "../src/params";
import type { ConsultResponse } from "../src";
import { CHAIN_ID, SWAP_NOW, makePolicy, makeRequest } from "./fixtures";

const NOW = SWAP_NOW;
const MARKET_PARAMS_ID = "defi-param-unknown-token-thresholds.json";
const MARKET_IDS = [
  "asset-liquidity-sufficient",
  "asset-holders-sufficient",
  "asset-activity-sufficient",
];
const BUNDLE = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "params-bundle.json"), "utf8")
);

// Test numbers only, picked for these tests. The service supplies the real
// values at run time; none lives in this repository.
const THRESHOLDS: Record<string, number> = {
  liquidity_abs_deny_below_usd: 4321,
  liquidity_abs_pass_at_or_above_usd: 43210,
  holders_deny_below: 77,
  holders_pass_at_or_above: 777,
  activity_window_hours: 9,
  activity_min_distinct_counterparties: 4,
  activity_recent_event_max_age_hours: 3,
  qualifying_event_min_usd: 7,
};
const HOUR = 3600;
const WINDOW = THRESHOLDS.activity_window_hours * HOUR;
const RECENT = THRESHOLDS.activity_recent_event_max_age_hours * HOUR;

// The fixture bundle's market constants, with test numbers in place of
// its words.
function bundleWith(values: Record<string, unknown>): unknown {
  const bundle = JSON.parse(JSON.stringify(BUNDLE));
  for (const [key, value] of Object.entries(values)) {
    bundle[MARKET_PARAMS_ID][key].value = value;
  }
  return bundle;
}

// Base bridged USDT (0xfde4...9bb2): not Tether, and not in any table here.
const BRIDGED_USDT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const ETHEREUM_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const LOOKALIKE_USDT = "0x" + "7".repeat(40);
const SENDERS = ["a", "b", "c", "d", "e"].map((c) => "0x" + c.repeat(40));

function unknownPay(chainId = BASE_CHAIN_ID, address = BRIDGED_USDT) {
  return {
    request: makeRequest({
      action: {
        ...makeRequest().action,
        chainId,
        asset: { symbol: "USDT", contractAddress: address },
        target: address,
      },
    }),
    policy: makePolicy({ chainId, perActionCapAssets: { pay: address } }),
  };
}

// 721,004 holders, about $7.2M in pools, and a transfer 7 seconds old.
function bridgedSignals(overrides: Record<string, unknown> = {}) {
  return {
    chainId: BASE_CHAIN_ID,
    contractAddress: BRIDGED_USDT,
    liquidity: { usd: 7_200_000, readAt: NOW },
    holders: { count: 721_004, readAt: NOW },
    activity: {
      readAt: NOW,
      since: NOW - WINDOW,
      transfers: SENDERS.map((sender, i) => ({
        at: NOW - 7 - i * 60,
        sender,
        usd: 250,
      })),
    },
    ...overrides,
  };
}

function marketFacts(
  signals: unknown = bridgedSignals(),
  params: unknown = bundleWith(THRESHOLDS),
  extra: Record<string, unknown> = {}
) {
  return { now: NOW, params, marketSignals: signals, ...extra };
}

function row(response: ConsultResponse, id: string) {
  const found = response.results.find((result) => result.id === id);
  expect(found, id).to.not.equal(undefined);
  return found!;
}

function codes(response: ConsultResponse): string[] {
  return MARKET_IDS.map((id) => row(response, id).code);
}

function runUnknown(signals: unknown, params?: unknown) {
  const { request, policy } = unknownPay();
  return consult(
    request,
    policy,
    marketFacts(signals, params === undefined ? bundleWith(THRESHOLDS) : params)
  );
}

function activityOf(transfers: unknown, overrides = {}) {
  return bridgedSignals({
    activity: { readAt: NOW, since: NOW - WINDOW, transfers, ...overrides },
  });
}

describe("market signals: three Floor Conditions for an unknown pay asset", () => {
  it("adds the three Conditions to the end of the pay Floor", () => {
    const response = consult(makeRequest(), makePolicy());
    expect(response.results.slice(-3).map((result) => result.id)).to.deep.equal(
      MARKET_IDS
    );
  });

  it("the max reading age is 60 seconds", () => {
    expect(MAX_MARKET_READING_AGE_SECONDS).to.equal(60);
  });

  it("reads exactly its eight constants, all from the unknown-token file", () => {
    const market = PARAM_READS.filter(([id]) => id === MARKET_PARAMS_ID);
    expect(market.map(([, key]) => key)).to.have.members(
      Object.keys(THRESHOLDS)
    );
    expect(market).to.have.length(8);
  });

  describe("a known asset", () => {
    it("passes all three with NOT_REQUIRED from the static registry, reading nothing", () => {
      const response = consult(
        makeRequest(),
        makePolicy(),
        marketFacts({ garbage: true }, "not a bundle")
      );
      expect(codes(response)).to.deep.equal([
        "ASSET_LIQUIDITY_NOT_REQUIRED",
        "ASSET_HOLDERS_NOT_REQUIRED",
        "ASSET_ACTIVITY_NOT_REQUIRED",
      ]);
      for (const id of MARKET_IDS) {
        expect(row(response, id).status).to.equal("PASS");
        expect(row(response, id).evidenceClass).to.equal("static-registry");
      }
      expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
      expect(response.proceed).to.equal(true);
      expect(response.support).to.equal(0.92);
    });

    it("assetKnownTo is true for a code-table asset at its own address and false elsewhere", () => {
      expect(assetKnownTo(makeRequest(), undefined)).to.equal(true);
      expect(assetKnownTo(unknownPay().request, { now: NOW })).to.equal(false);
      expect(
        assetKnownTo(unknownPay(CHAIN_ID, LOOKALIKE_USDT).request, {})
      ).to.equal(false);
      expect(assetKnownTo({} as never, undefined)).to.equal(false);
      expect(assetKnownTo(null as never, undefined)).to.equal(false);
    });

    const registryRow = (overrides: Record<string, unknown> = {}) => ({
      chainId: CHAIN_ID,
      symbol: "USDT",
      contractAddress: ETHEREUM_USDT,
      expiresAt: NOW + 86_400,
      liveRead: "confirmed",
      liveReadAt: NOW,
      ...overrides,
    });

    it("a confirmed registry row at the request's own address makes the asset known", () => {
      const { request, policy } = unknownPay(CHAIN_ID, ETHEREUM_USDT);
      const facts = { now: NOW, registryAsset: registryRow() };
      expect(assetKnownTo(request, facts)).to.equal(true);
      expect(codes(consult(request, policy, facts))).to.deep.equal([
        "ASSET_LIQUIDITY_NOT_REQUIRED",
        "ASSET_HOLDERS_NOT_REQUIRED",
        "ASSET_ACTIVITY_NOT_REQUIRED",
      ]);
    });

    for (const [label, overrides] of [
      ["mismatch", { liveRead: "mismatch" }],
      ["unconfirmed", { liveRead: "unconfirmed" }],
      ["a stale confirmed read", { liveReadAt: NOW - 61 }],
      ["no live read", { liveRead: undefined, liveReadAt: undefined }],
    ] as const) {
      it(`a registry row with ${label} does not make the asset known`, () => {
        const { request, policy } = unknownPay(CHAIN_ID, ETHEREUM_USDT);
        const facts = { now: NOW, registryAsset: registryRow(overrides) };
        expect(assetKnownTo(request, facts)).to.equal(false);
        expect(codes(consult(request, policy, facts))).to.deep.equal([
          "ASSET_LIQUIDITY_READING_MISSING",
          "ASSET_HOLDERS_READING_MISSING",
          "ASSET_ACTIVITY_READING_MISSING",
        ]);
      });
    }
  });

  describe("an unknown asset", () => {
    it("Base bridged USDT passes all three and is still UNKNOWN, never ALLOW", () => {
      const response = runUnknown(bridgedSignals());
      expect(codes(response)).to.deep.equal([
        "ASSET_LIQUIDITY_SUFFICIENT",
        "ASSET_HOLDERS_SUFFICIENT",
        "ASSET_ACTIVITY_SUFFICIENT",
      ]);
      for (const id of MARKET_IDS) {
        expect(row(response, id).status).to.equal("PASS");
        expect(row(response, id).evidenceClass).to.equal("onchain-read");
      }
      expect(response.verdict).to.equal("UNKNOWN");
      expect(response.proceed).to.equal(false);
    });

    it("a thin unlisted token is DENY", () => {
      const response = runUnknown(
        bridgedSignals({
          liquidity: { usd: 12, readAt: NOW },
          holders: { count: 3, readAt: NOW },
          activity: { readAt: NOW, since: NOW - WINDOW, transfers: [] },
        })
      );
      expect(codes(response)).to.deep.equal([
        "ASSET_LIQUIDITY_BELOW_THRESHOLD",
        "ASSET_HOLDERS_BELOW_THRESHOLD",
        "ASSET_ACTIVITY_BELOW_THRESHOLD",
      ]);
      for (const id of MARKET_IDS) {
        expect(row(response, id).status).to.equal("FAIL");
        expect(row(response, id).evidenceClass).to.equal("onchain-read");
      }
      expect(response.verdict).to.equal("DENY");
    });

    it("a contract claiming USDT at the wrong address is DENY, with the market Conditions run too", () => {
      const { request, policy } = unknownPay(CHAIN_ID, LOOKALIKE_USDT);
      const facts = {
        now: NOW,
        registryAsset: {
          chainId: CHAIN_ID,
          symbol: "USDT",
          contractAddress: ETHEREUM_USDT,
          expiresAt: NOW + 86_400,
          liveRead: "confirmed",
          liveReadAt: NOW,
        },
        params: bundleWith(THRESHOLDS),
        marketSignals: bridgedSignals({
          chainId: CHAIN_ID,
          contractAddress: LOOKALIKE_USDT,
          liquidity: { usd: 12, readAt: NOW },
        }),
      };
      const response = consult(request, policy, facts);
      expect(row(response, "asset-is-canonical").code).to.equal(
        "ASSET_NOT_CANONICAL"
      );
      expect(codes(response)).to.deep.equal([
        "ASSET_LIQUIDITY_BELOW_THRESHOLD",
        "ASSET_HOLDERS_SUFFICIENT",
        "ASSET_ACTIVITY_SUFFICIENT",
      ]);
      expect(response.verdict).to.equal("DENY");
    });

    it("with no params bundle, or the shipped fixture words, each is UNVERIFIED", () => {
      for (const params of [undefined, BUNDLE]) {
        const { request, policy } = unknownPay();
        const facts =
          params === undefined
            ? { now: NOW, marketSignals: bridgedSignals() }
            : marketFacts(bridgedSignals(), params);
        const response = consult(request, policy, facts);
        expect(codes(response)).to.deep.equal([
          "ASSET_LIQUIDITY_THRESHOLD_UNAVAILABLE",
          "ASSET_HOLDERS_THRESHOLD_UNAVAILABLE",
          "ASSET_ACTIVITY_THRESHOLD_UNAVAILABLE",
        ]);
        for (const id of MARKET_IDS) {
          expect(row(response, id).status).to.equal("UNVERIFIED");
        }
      }
    });

    it("a threshold that is negative, not a number, or a deny line above the pass line is UNVERIFIED", () => {
      for (const values of [
        { ...THRESHOLDS, holders_deny_below: -1 },
        { ...THRESHOLDS, holders_deny_below: "77" },
        { ...THRESHOLDS, holders_deny_below: 778 },
      ]) {
        expect(
          row(
            runUnknown(bridgedSignals(), bundleWith(values)),
            "asset-holders-sufficient"
          ).code
        ).to.equal("ASSET_HOLDERS_THRESHOLD_UNAVAILABLE");
      }
    });

    it("a constant without its scrub record leaves no usable threshold", () => {
      const bundle = bundleWith(THRESHOLDS) as Record<string, any>;
      delete bundle[MARKET_PARAMS_ID].holders_deny_below.scrub;
      expect(codes(runUnknown(bridgedSignals(), bundle))).to.deep.equal([
        "ASSET_LIQUIDITY_THRESHOLD_UNAVAILABLE",
        "ASSET_HOLDERS_THRESHOLD_UNAVAILABLE",
        "ASSET_ACTIVITY_THRESHOLD_UNAVAILABLE",
      ]);
    });

    it("evidence never echoes a threshold number", () => {
      const response = runUnknown(
        bridgedSignals({ liquidity: { usd: 12, readAt: NOW } })
      );
      for (const id of MARKET_IDS) {
        // The multi-digit test thresholds, which no reading here contains.
        for (const value of [4321, 43210, 77, 777]) {
          expect(row(response, id).evidence).not.to.include(String(value));
        }
      }
    });
  });

  describe("boundaries, from the fixture bundle's constants", () => {
    const liquidity = (usd: number) =>
      row(
        runUnknown(bridgedSignals({ liquidity: { usd, readAt: NOW } })),
        "asset-liquidity-sufficient"
      ).code;
    const holders = (count: number) =>
      row(
        runUnknown(bridgedSignals({ holders: { count, readAt: NOW } })),
        "asset-holders-sufficient"
      ).code;

    it("liquidity: at the pass line PASS, under it the UNKNOWN band, under the deny line DENY", () => {
      const pass = THRESHOLDS.liquidity_abs_pass_at_or_above_usd;
      const deny = THRESHOLDS.liquidity_abs_deny_below_usd;
      expect(liquidity(pass)).to.equal("ASSET_LIQUIDITY_SUFFICIENT");
      expect(liquidity(pass - 0.01)).to.equal(
        "ASSET_LIQUIDITY_IN_UNKNOWN_BAND"
      );
      expect(liquidity(deny)).to.equal("ASSET_LIQUIDITY_IN_UNKNOWN_BAND");
      expect(liquidity(deny - 0.01)).to.equal(
        "ASSET_LIQUIDITY_BELOW_THRESHOLD"
      );
    });

    it("holders: at the pass line PASS, under it the UNKNOWN band, under the deny line DENY", () => {
      const pass = THRESHOLDS.holders_pass_at_or_above;
      const deny = THRESHOLDS.holders_deny_below;
      expect(holders(pass)).to.equal("ASSET_HOLDERS_SUFFICIENT");
      expect(holders(pass - 1)).to.equal("ASSET_HOLDERS_IN_UNKNOWN_BAND");
      expect(holders(deny)).to.equal("ASSET_HOLDERS_IN_UNKNOWN_BAND");
      expect(holders(deny - 1)).to.equal("ASSET_HOLDERS_BELOW_THRESHOLD");
    });

    it("the UNKNOWN band is UNVERIFIED, never PASS", () => {
      const response = runUnknown(
        bridgedSignals({ holders: { count: 100, readAt: NOW } })
      );
      expect(row(response, "asset-holders-sufficient").status).to.equal(
        "UNVERIFIED"
      );
    });

    const activity = (transfers: unknown, overrides = {}) =>
      row(
        runUnknown(activityOf(transfers, overrides)),
        "asset-activity-sufficient"
      ).code;
    const minUsd = THRESHOLDS.qualifying_event_min_usd;
    const senders = (n: number, age = 0) =>
      SENDERS.slice(0, n).map((sender) => ({
        at: NOW - age,
        sender,
        usd: minUsd,
      }));

    it("activity: enough distinct senders with a recent event PASS, one fewer is the UNKNOWN band", () => {
      const min = THRESHOLDS.activity_min_distinct_counterparties;
      expect(activity(senders(min))).to.equal("ASSET_ACTIVITY_SUFFICIENT");
      expect(activity(senders(min - 1))).to.equal(
        "ASSET_ACTIVITY_IN_UNKNOWN_BAND"
      );
    });

    it("activity: the newest event at the recency line PASS, one second older the UNKNOWN band", () => {
      const min = THRESHOLDS.activity_min_distinct_counterparties;
      expect(activity(senders(min, RECENT))).to.equal(
        "ASSET_ACTIVITY_SUFFICIENT"
      );
      expect(activity(senders(min, RECENT + 1))).to.equal(
        "ASSET_ACTIVITY_IN_UNKNOWN_BAND"
      );
    });

    it("activity: no qualifying transfer in the window is DENY", () => {
      const min = THRESHOLDS.activity_min_distinct_counterparties;
      expect(activity([])).to.equal("ASSET_ACTIVITY_BELOW_THRESHOLD");
      expect(
        activity(senders(min, WINDOW + 1), { since: NOW - WINDOW - 10 })
      ).to.equal("ASSET_ACTIVITY_BELOW_THRESHOLD");
      expect(activity(senders(min, WINDOW))).to.equal(
        "ASSET_ACTIVITY_IN_UNKNOWN_BAND"
      );
    });

    it("activity: zero-value and under-minimum transfers never count", () => {
      const tiny = (usd: number) =>
        SENDERS.map((sender) => ({ at: NOW, sender, usd }));
      expect(activity(tiny(0))).to.equal("ASSET_ACTIVITY_BELOW_THRESHOLD");
      expect(activity(tiny(minUsd - 0.01))).to.equal(
        "ASSET_ACTIVITY_BELOW_THRESHOLD"
      );
      expect(activity(tiny(minUsd))).to.equal("ASSET_ACTIVITY_SUFFICIENT");
    });

    it("activity: a sender counts once, whatever its letter case", () => {
      const min = THRESHOLDS.activity_min_distinct_counterparties;
      const same = Array.from({ length: min }, (_, i) => ({
        at: NOW,
        sender:
          i % 2 === 0
            ? SENDERS[0]
            : SENDERS[0].toUpperCase().replace("0X", "0x"),
        usd: minUsd,
      }));
      expect(activity(same)).to.equal("ASSET_ACTIVITY_IN_UNKNOWN_BAND");
    });

    it("activity: a read that does not cover the whole window is UNVERIFIED", () => {
      expect(activity(senders(3), { since: NOW - WINDOW + 1 })).to.equal(
        "ASSET_ACTIVITY_WINDOW_UNCOVERED"
      );
    });
  });

  describe("readings that cannot be trusted are UNVERIFIED, never PASS", () => {
    const allThree = (
      signals: unknown,
      extra: Record<string, unknown> = {}
    ) => {
      const { request, policy } = unknownPay();
      return codes(
        consult(request, policy, marketFacts(signals, undefined, extra))
      );
    };
    const each = (suffix: string) =>
      ["LIQUIDITY", "HOLDERS", "ACTIVITY"].map(
        (dim) => `ASSET_${dim}_${suffix}`
      );
    const dated = (readAt: number) =>
      bridgedSignals({
        liquidity: { usd: 7_200_000, readAt },
        holders: { count: 721_004, readAt },
        activity: {
          readAt,
          since: readAt - WINDOW,
          transfers: SENDERS.map((sender) => ({
            at: readAt,
            sender,
            usd: 250,
          })),
        },
      });

    it("missing: no marketSignals, or a dimension left out", () => {
      expect(allThree(null)).to.deep.equal(each("READING_MISSING"));
      expect(
        allThree(
          bridgedSignals({
            liquidity: undefined,
            holders: undefined,
            activity: undefined,
          })
        )
      ).to.deep.equal(each("READING_MISSING"));
    });

    it("stale: older than 60 seconds; fresh at exactly 60", () => {
      expect(
        allThree(dated(NOW - MAX_MARKET_READING_AGE_SECONDS - 1))
      ).to.deep.equal(each("READING_STALE"));
      expect(
        allThree(dated(NOW - MAX_MARKET_READING_AGE_SECONDS))
      ).to.deep.equal(each("SUFFICIENT"));
    });

    it("late: a readAt after facts.now", () => {
      expect(allThree(dated(NOW + 1))).to.deep.equal(each("READING_STALE"));
    });

    it("no facts.now to date the reading", () => {
      const { request, policy } = unknownPay();
      const response = consult(request, policy, {
        params: bundleWith(THRESHOLDS),
        marketSignals: bridgedSignals(),
      });
      expect(codes(response)).to.deep.equal(each("READING_AGE_UNKNOWN"));
    });

    it("malformed readings", () => {
      for (const bad of [
        { usd: -1, readAt: NOW },
        { usd: "7200000", readAt: NOW },
        { usd: 7_200_000, readAt: 1.5 },
        { usd: 7_200_000 },
        "not a reading",
      ]) {
        expect(
          allThree(bridgedSignals({ liquidity: bad }))[0],
          JSON.stringify(bad)
        ).to.equal("ASSET_LIQUIDITY_READING_MALFORMED");
      }
      expect(
        allThree(bridgedSignals({ holders: { count: 1.5, readAt: NOW } }))[1]
      ).to.equal("ASSET_HOLDERS_READING_MALFORMED");
      for (const transfers of [
        "none",
        [{ at: NOW, sender: "not an address", usd: 250 }],
        [{ at: NOW + 1, sender: SENDERS[0], usd: 250 }],
        [{ at: NOW, sender: SENDERS[0], usd: -1 }],
      ]) {
        expect(
          allThree(activityOf(transfers))[2],
          JSON.stringify(transfers)
        ).to.equal("ASSET_ACTIVITY_READING_MALFORMED");
      }
    });

    it("wrong subject: another address or another chain", () => {
      expect(
        allThree(bridgedSignals({ contractAddress: LOOKALIKE_USDT }))
      ).to.deep.equal(each("SUBJECT_MISMATCH"));
      expect(allThree(bridgedSignals({ chainId: CHAIN_ID }))).to.deep.equal(
        each("SUBJECT_MISMATCH")
      );
    });
  });
});
