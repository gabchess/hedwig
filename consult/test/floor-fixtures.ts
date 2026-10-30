import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BASE_CHAIN_ID } from "../src/catalog";
import type { ConsultRequest } from "../src/catalog";
import type { ConsultResponse } from "../src";
import {
  ASSET_ADDRESS,
  ASSET_SYMBOL,
  CHAIN_ID,
  SWAP_NOW,
  WETH_ADDRESS,
  WETH_SYMBOL,
  makeRequest,
  makeSwapRequest,
} from "./fixtures";

export const NOW = SWAP_NOW;
export const SLIPPAGE_FILE = "defi-param-slippage-mev.json";
export const UNKNOWN_FILE = "defi-param-unknown-token-thresholds.json";
export const TAX_ID = "token-tax-within-bound";
export const SLIPPAGE_ID = "slippage-within-floor-ceiling";

const BUNDLE_TEXT = readFileSync(
  join(__dirname, "fixtures", "params-bundle.json"),
  "utf8"
);

// Test numbers only, picked for these tests and all different, so a Check
// that reads the wrong constant lands on a different verdict. The service
// supplies the real values at run time; none lives in this repository.
export const FLOOR_NUMBERS = {
  [SLIPPAGE_FILE]: {
    tolerance_cap_deny_above_bps: 77,
    tolerance_floor_bps: 13,
    tax_plus_honest_tolerance_max_bps: 230,
  },
  [UNKNOWN_FILE]: {
    liquidity_abs_deny_below_usd: 4321,
    liquidity_abs_pass_at_or_above_usd: 43210,
    holders_deny_below: 77,
    holders_pass_at_or_above: 777,
    activity_window_hours: 9,
    activity_min_distinct_counterparties: 4,
    activity_recent_event_max_age_hours: 3,
    qualifying_event_min_usd: 7,
    tax_plus_honest_tolerance_deny_above_bps: 170,
  },
} as const;

export const CAP = FLOOR_NUMBERS[SLIPPAGE_FILE].tolerance_cap_deny_above_bps;
export const TOL_FLOOR = FLOOR_NUMBERS[SLIPPAGE_FILE].tolerance_floor_bps;
export const TAX_MAX =
  FLOOR_NUMBERS[SLIPPAGE_FILE].tax_plus_honest_tolerance_max_bps;
export const TAX_UNKNOWN =
  FLOOR_NUMBERS[UNKNOWN_FILE].tax_plus_honest_tolerance_deny_above_bps;

type Bundle = Record<string, Record<string, Record<string, unknown>>>;

// The fixture bundle with the test numbers in place of its words. `edit`
// lets a test delete or relabel a constant before the bundle is used.
export function floorBundle(edit?: (bundle: Bundle) => void): Bundle {
  const bundle: Bundle = JSON.parse(BUNDLE_TEXT);
  for (const [file, values] of Object.entries(FLOOR_NUMBERS)) {
    for (const [key, value] of Object.entries(values)) {
      bundle[file][key].value = value;
    }
  }
  edit?.(bundle);
  return bundle;
}

export function withConstant(
  file: string,
  key: string,
  value: unknown
): Bundle {
  return floorBundle((bundle) => {
    bundle[file][key].value = value;
  });
}

export function withoutConstant(file: string, key: string): Bundle {
  return floorBundle((bundle) => {
    delete bundle[file][key];
  });
}

// -- pay ------------------------------------------------------------------

export const ETHEREUM_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
export const FAKE_USDT = "0x" + "7".repeat(40);
export const BRIDGED_USDT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
export const THIN_TOKEN = "0x" + "9".repeat(40);

export function usdtRegistryFact(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    chainId: CHAIN_ID,
    symbol: "USDT",
    contractAddress: ETHEREUM_USDT,
    expiresAt: NOW + 86_400,
    liveRead: "confirmed",
    liveReadAt: NOW,
    ...overrides,
  };
}

export function payOf(
  symbol: string,
  address: string,
  chainId = CHAIN_ID
): ConsultRequest {
  return makeRequest({
    action: {
      ...makeRequest().action,
      chainId,
      asset: { symbol, contractAddress: address },
      target: address,
    },
  });
}

const SENDERS = ["a", "b", "c", "d", "e"].map((c) => "0x" + c.repeat(40));

// A token with deep pools, many holders and fresh transfers.
export function healthySignals(chainId: string, address: string) {
  return {
    chainId,
    contractAddress: address,
    liquidity: { usd: 7_200_000, readAt: NOW },
    holders: { count: 721_004, readAt: NOW },
    activity: {
      readAt: NOW,
      since: NOW - FLOOR_NUMBERS[UNKNOWN_FILE].activity_window_hours * 3600,
      transfers: SENDERS.map((sender, i) => ({
        at: NOW - 7 - i * 60,
        sender,
        usd: 250,
      })),
    },
  };
}

// Pools worth 12 dollars and 3 holders, under both deny lines.
export function thinSignals(chainId: string, address: string) {
  return {
    ...healthySignals(chainId, address),
    liquidity: { usd: 12, readAt: NOW },
    holders: { count: 3, readAt: NOW },
  };
}

export { BASE_CHAIN_ID };

// -- swap -----------------------------------------------------------------

// A request that moves `bps` basis points under its quote: quotedOut 1e6 and
// minOut the quote less bps/10000 of it.
export function swapAt(bps: number, extraGap = 0): ConsultRequest {
  const quotedOut = 1_000_000;
  const minOut = quotedOut - bps * 100 - extraGap;
  return makeSwapRequest({
    action: {
      ...makeSwapRequest().action,
      quotedOut: String(quotedOut),
      minOut: String(minOut),
      slippageBps: Math.floor(((quotedOut - minOut) * 10000) / quotedOut),
    },
  });
}

export function taxEntry(
  address: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    chainId: CHAIN_ID,
    address,
    taxBps: 0,
    sellBlocked: false,
    asOf: NOW,
    source: "canonical",
    ...overrides,
  };
}

export const USDC_TAX = taxEntry(ASSET_ADDRESS);
export const WETH_TAX = taxEntry(WETH_ADDRESS);

// Marks a Fact or the params bundle as absent. A bare `undefined` argument
// means "the default", because a default parameter swallows it.
export const NONE = Symbol("absent");

export function swapFacts(
  tokenTax: unknown = [USDC_TAX, WETH_TAX],
  params: unknown = floorBundle(),
  extra: Record<string, unknown> = {}
) {
  return {
    now: NOW,
    ...(params === NONE ? {} : { params }),
    ...(tokenTax === NONE ? {} : { tokenTax }),
    ...extra,
  };
}

export function swapOf(
  tokenOut: { symbol: string; contractAddress: string },
  tokenIn = { symbol: ASSET_SYMBOL, contractAddress: ASSET_ADDRESS }
): ConsultRequest {
  return makeSwapRequest({
    action: { ...makeSwapRequest().action, tokenIn, tokenOut },
  });
}

export const WETH = { symbol: WETH_SYMBOL, contractAddress: WETH_ADDRESS };
export const UNLISTED_TOKEN = {
  symbol: "ZZZ",
  contractAddress: "0x" + "5".repeat(40),
};

export function row(response: ConsultResponse, id: string) {
  const found = response.results.find((result) => result.id === id);
  if (found === undefined) {
    throw new Error(`no row ${id}: ${response.results.map((r) => r.id)}`);
  }
  return found;
}
