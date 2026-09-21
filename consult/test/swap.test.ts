import { expect } from "chai";

import { consult } from "../src";
import {
  APPROVED_RECIPIENT,
  ASSET_ADDRESS,
  ASSET_SYMBOL,
  ROUTER_ADDRESS,
  SWAP_NOW,
  WETH_SYMBOL,
  makeSwapFacts,
  makeSwapPolicy,
  makeSwapRequest,
} from "./fixtures";

const SWAP_FLOOR_IDS = [
  "target-is-canonical",
  "token-in-is-canonical",
  "token-out-is-canonical",
  "slippage-within-ceiling",
  "deadline-set-and-fresh",
  "output-recipient-is-owner",
  "approval-scoped-to-this-swap",
  "amount-within-cap",
  "chain-matches-intent",
  "role-requirement-met",
];

// `arguments.length`, not a JS default parameter, decides whether `facts`
// was actually supplied: a default parameter would silently replace an
// explicitly-passed `undefined` with a real facts object, which is exactly
// the case several tests below need to send through untouched.
function swap(
  actionOverrides: Record<string, unknown> = {},
  policyOverrides: Parameters<typeof makeSwapPolicy>[0] = {},
  facts?: unknown
) {
  const request = makeSwapRequest({
    action: { ...makeSwapRequest().action, ...actionOverrides },
  });
  const effectiveFacts = arguments.length >= 3 ? facts : makeSwapFacts();
  return consult(
    request,
    makeSwapPolicy(policyOverrides),
    effectiveFacts as never
  );
}

describe("consult: swap", () => {
  it("returns ALLOW_UNDER_POLICY when every Floor Condition passes and the policy permits", () => {
    const response = swap();

    expect(response.verdict).to.equal("ALLOW_UNDER_POLICY");
    expect(response.proceed).to.equal(true);
    expect(response.question).to.equal(
      "Should this agent proceed with this swap under the owner's policy?"
    );
    expect(response.floorIds).to.have.members(SWAP_FLOOR_IDS);
    expect(response.results).to.have.length(SWAP_FLOOR_IDS.length);
    response.results.forEach((result) => {
      expect(result.status, result.id).to.equal("PASS");
    });
  });

  it("has its own top-level question, distinct from pay's", () => {
    const response = swap();
    expect(response.question).to.not.include("payment");
    expect(response.question).to.include("swap");
  });

  describe("pinned acceptance: slippage-within-ceiling", () => {
    it("derived 1000 bps over a ceiling of 100 denies, support 0, proceed false", () => {
      const response = swap(
        { quotedOut: "1000000", minOut: "900000", slippageBps: 1000 },
        { maxSlippageBps: 100 }
      );
      const row = response.results.find(
        (r) => r.id === "slippage-within-ceiling"
      );
      expect(row?.status).to.equal("FAIL");
      expect(row?.code).to.equal("SLIPPAGE_EXCEEDS_CEILING");
      expect(response.verdict).to.equal("DENY");
      expect(response.support).to.equal(0);
      expect(response.proceed).to.equal(false);
    });

    it("derived 50 bps within a ceiling of 100 passes on that row", () => {
      const response = swap(
        { minOut: "995000", slippageBps: 50 },
        { maxSlippageBps: 100 }
      );
      const row = response.results.find(
        (r) => r.id === "slippage-within-ceiling"
      );
      expect(row?.status).to.equal("PASS");
      expect(row?.code).to.equal("SLIPPAGE_WITHIN_CEILING");
    });

    it("a declared slippageBps that differs from the derived one fails with SLIPPAGE_DECLARED_MISMATCH", () => {
      const response = swap(
        { minOut: "995000", slippageBps: 10 },
        { maxSlippageBps: 100 }
      );
      const row = response.results.find(
        (r) => r.id === "slippage-within-ceiling"
      );
      expect(row?.status).to.equal("FAIL");
      expect(row?.code).to.equal("SLIPPAGE_DECLARED_MISMATCH");
    });
  });

  describe("slippage-within-ceiling hostile ranges", () => {
    const HOSTILE_SLIPPAGE_BPS: unknown[] = [
      1.5,
      "50",
      -1,
      10001,
      NaN,
      true,
      [],
      {},
    ];

    HOSTILE_SLIPPAGE_BPS.forEach((slippageBps) => {
      it(`slippageBps ${JSON.stringify(
        slippageBps
      )} never earns a PASS`, () => {
        const response = swap({ slippageBps });
        const row = response.results.find(
          (r) => r.id === "slippage-within-ceiling"
        );
        expect(row?.status, JSON.stringify(slippageBps)).to.not.equal("PASS");
        expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
      });
    });

    const HOSTILE_QUOTED_MIN: Array<[unknown, unknown]> = [
      ["0", "0"],
      ["1000000", "0"],
      ["1000000", "1000001"],
      ["-5", "1000"],
      ["1000000", "-5"],
    ];
    HOSTILE_QUOTED_MIN.forEach(([quotedOut, minOut]) => {
      it(`quotedOut ${JSON.stringify(quotedOut)} / minOut ${JSON.stringify(
        minOut
      )} never earns a PASS`, () => {
        const response = swap({ quotedOut, minOut });
        const row = response.results.find(
          (r) => r.id === "slippage-within-ceiling"
        );
        expect(row?.status).to.not.equal("PASS");
        expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
      });
    });

    it("a missing slippage ceiling in the policy is UNVERIFIED, not a crash", () => {
      const response = swap({}, { maxSlippageBps: undefined });
      const row = response.results.find(
        (r) => r.id === "slippage-within-ceiling"
      );
      expect(row?.status).to.equal("UNVERIFIED");
      expect(row?.code).to.equal("SLIPPAGE_CEILING_MISSING");
      expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
    });
  });

  describe("deadline-set-and-fresh", () => {
    it("a deadline in the past fails", () => {
      const response = swap({ deadline: SWAP_NOW - 1000 });
      const row = response.results.find(
        (r) => r.id === "deadline-set-and-fresh"
      );
      expect(row?.status).to.equal("FAIL");
      expect(row?.code).to.equal("DEADLINE_PAST");
    });

    it("a deadline equal to now fails: it must be strictly after", () => {
      const response = swap({ deadline: SWAP_NOW });
      const row = response.results.find(
        (r) => r.id === "deadline-set-and-fresh"
      );
      expect(row?.status).to.equal("FAIL");
      expect(row?.code).to.equal("DEADLINE_PAST");
    });

    it("a deadline further out than the owner's window fails", () => {
      const response = swap({ deadline: SWAP_NOW + 10_000 });
      const row = response.results.find(
        (r) => r.id === "deadline-set-and-fresh"
      );
      expect(row?.status).to.equal("FAIL");
      expect(row?.code).to.equal("DEADLINE_TOO_FAR");
    });

    const HOSTILE_DEADLINES: unknown[] = [
      "2000000300",
      2000000300.5,
      2 ** 53,
      NaN,
      true,
      [],
    ];
    HOSTILE_DEADLINES.forEach((deadline) => {
      it(`deadline ${JSON.stringify(
        deadline
      )} is UNVERIFIED, never PASS`, () => {
        const response = swap({ deadline });
        const row = response.results.find(
          (r) => r.id === "deadline-set-and-fresh"
        );
        expect(row?.status, JSON.stringify(deadline)).to.equal("UNVERIFIED");
        expect(row?.code).to.equal("DEADLINE_MALFORMED");
      });
    });

    it("missing, null, or an array for facts leaves the row UNVERIFIED, never a crash", () => {
      [undefined, null, []].forEach((facts) => {
        expect(() => swap({}, {}, facts)).to.not.throw();
        const response = swap({}, {}, facts);
        const row = response.results.find(
          (r) => r.id === "deadline-set-and-fresh"
        );
        expect(row?.status, JSON.stringify(facts)).to.equal("UNVERIFIED");
        expect(row?.code).to.equal("DEADLINE_NOW_UNAVAILABLE");
        expect(response.verdict).to.not.equal("ALLOW_UNDER_POLICY");
      });
    });

    it("facts.now as a string or zero leaves the row UNVERIFIED", () => {
      [{ now: "2000000000" }, { now: 0 }].forEach((facts) => {
        const response = swap({}, {}, facts);
        const row = response.results.find(
          (r) => r.id === "deadline-set-and-fresh"
        );
        expect(row?.status, JSON.stringify(facts)).to.equal("UNVERIFIED");
        expect(row?.code).to.equal("DEADLINE_NOW_UNAVAILABLE");
      });
    });

    it("a missing maxDeadlineSeconds is UNVERIFIED, not a crash", () => {
      const response = swap({}, { maxDeadlineSeconds: undefined });
      const row = response.results.find(
        (r) => r.id === "deadline-set-and-fresh"
      );
      expect(row?.status).to.equal("UNVERIFIED");
      expect(row?.code).to.equal("DEADLINE_CEILING_MISSING");
    });

    it("pay under a policy that requires no role ignores facts entirely: every existing pay test passes unchanged with or without a third argument", () => {
      // Covered structurally: consult(request, policy) with no third
      // argument is exercised by every pay test in consult.test.ts and
      // hardening.test.ts, none of which were touched by this ticket.
      // This test only pins that calling with an explicit facts argument
      // for a pay request changes nothing.
      const request = {
        action: {
          type: "pay",
          chainId: "eip155:1",
          recipient: APPROVED_RECIPIENT,
          asset: { symbol: ASSET_SYMBOL, contractAddress: ASSET_ADDRESS },
          amount: "1000000",
          target: ASSET_ADDRESS,
        },
      };
      const policy = {
        permits: true,
        chainId: "eip155:1",
        approvedRecipients: [APPROVED_RECIPIENT],
        perActionCaps: { pay: "1000000" },
      };
      const withoutFacts = consult(request as never, policy as never);
      const withFacts = consult(
        request as never,
        policy as never,
        { now: SWAP_NOW } as never
      );
      expect(withFacts).to.deep.equal(withoutFacts);
    });
  });

  describe("output-recipient-is-owner", () => {
    it("a recipient not in the owner's list fails", () => {
      const response = swap({
        recipient: "0x000000000000000000000000000000000c0ffee1",
      });
      const row = response.results.find(
        (r) => r.id === "output-recipient-is-owner"
      );
      expect(row?.status).to.equal("FAIL");
      expect(row?.code).to.equal("SWAP_OUTPUT_RECIPIENT_NOT_OWNER");
    });

    it("a case variant of an owner address still passes its own row", () => {
      const caseVariant = "0x" + APPROVED_RECIPIENT.slice(2).toUpperCase();
      const response = swap({ recipient: caseVariant });
      const row = response.results.find(
        (r) => r.id === "output-recipient-is-owner"
      );
      expect(row?.status).to.equal("PASS");
    });

    it("a poison-flagged recipient fails even if it were in the owner's list", () => {
      const poisoned = "0x0000000000000000000000000000000000bad001";
      const response = swap(
        { recipient: poisoned },
        { ownerAddresses: [poisoned] }
      );
      const row = response.results.find(
        (r) => r.id === "output-recipient-is-owner"
      );
      expect(row?.status).to.equal("FAIL");
      expect(row?.code).to.equal("SWAP_RECIPIENT_POISON_DERIVED");
    });

    it("an empty or missing owner address list is UNVERIFIED, not a crash", () => {
      const response = swap({}, { ownerAddresses: [] });
      const row = response.results.find(
        (r) => r.id === "output-recipient-is-owner"
      );
      expect(row?.status).to.equal("UNVERIFIED");
      expect(row?.code).to.equal("SWAP_OWNER_ADDRESSES_INVALID");
    });
  });

  describe("approval-scoped-to-this-swap", () => {
    it("an approval larger than amountIn fails", () => {
      const response = swap({ approvalAmount: "1000001" });
      const row = response.results.find(
        (r) => r.id === "approval-scoped-to-this-swap"
      );
      expect(row?.status).to.equal("FAIL");
      expect(row?.code).to.equal("SWAP_APPROVAL_NOT_SCOPED");
    });

    it("an approval smaller than amountIn fails", () => {
      const response = swap({ approvalAmount: "999999" });
      const row = response.results.find(
        (r) => r.id === "approval-scoped-to-this-swap"
      );
      expect(row?.status).to.equal("FAIL");
    });

    it("a max-uint256 approval fails", () => {
      const response = swap({
        approvalAmount:
          "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      });
      const row = response.results.find(
        (r) => r.id === "approval-scoped-to-this-swap"
      );
      expect(row?.status).to.equal("FAIL");
    });
  });

  describe("token-in-is-canonical / token-out-is-canonical", () => {
    it("tokenIn and tokenOut naming the same contract fails both rows", () => {
      const response = swap({
        tokenOut: { symbol: ASSET_SYMBOL, contractAddress: ASSET_ADDRESS },
      });
      const tokenIn = response.results.find(
        (r) => r.id === "token-in-is-canonical"
      );
      const tokenOut = response.results.find(
        (r) => r.id === "token-out-is-canonical"
      );
      expect(tokenIn?.status).to.equal("FAIL");
      expect(tokenIn?.code).to.equal("SWAP_TOKEN_IN_SAME_AS_TOKEN_OUT");
      expect(tokenOut?.status).to.equal("FAIL");
      expect(tokenOut?.code).to.equal("SWAP_TOKEN_OUT_SAME_AS_TOKEN_IN");
    });

    it("an uncatalogued symbol is UNVERIFIED", () => {
      const response = swap({
        tokenIn: {
          symbol: "SCAM",
          contractAddress: "0x0000000000000000000000000000000005ca4001",
        },
      });
      const row = response.results.find(
        (r) => r.id === "token-in-is-canonical"
      );
      expect(row?.status).to.equal("UNVERIFIED");
      expect(row?.code).to.equal("SWAP_TOKEN_IN_REGISTRY_ENTRY_MISSING");
    });
  });

  describe("target-is-canonical (router)", () => {
    it("a router valid on a different chain does not validate here", () => {
      // Base's canonical router, used on mainnet: a real router address,
      // wrong chain.
      const response = swap({
        target: "0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40",
      });
      const row = response.results.find((r) => r.id === "target-is-canonical");
      expect(row?.status).to.equal("FAIL");
      expect(row?.code).to.equal("SWAP_TARGET_NOT_CANONICAL");
    });

    it("an unlisted chain is UNVERIFIED, never FAIL and never PASS", () => {
      const response = swap(
        { chainId: "eip155:999999", target: ROUTER_ADDRESS },
        { chainId: "eip155:999999" }
      );
      const row = response.results.find((r) => r.id === "target-is-canonical");
      expect(row?.status).to.equal("UNVERIFIED");
      expect(row?.code).to.equal("SWAP_TARGET_ROUTER_UNKNOWN");
    });

    it("the router contract is not the token contract", () => {
      const response = swap({ target: ASSET_ADDRESS });
      const row = response.results.find((r) => r.id === "target-is-canonical");
      expect(row?.status).to.equal("FAIL");
      expect(row?.code).to.equal("SWAP_TARGET_NOT_CANONICAL");
    });
  });

  describe("amount-within-cap (amountIn) and chain-matches-intent", () => {
    it("amountIn above the swap cap fails", () => {
      const response = swap(
        { amountIn: "1000001" },
        { perActionCaps: { pay: "1000000", swap: "1000000" } }
      );
      const row = response.results.find((r) => r.id === "amount-within-cap");
      expect(row?.status).to.equal("FAIL");
      expect(row?.code).to.equal("SWAP_AMOUNT_EXCEEDS_CAP");
    });

    it("a chain mismatch denies", () => {
      const response = swap(
        { chainId: "eip155:8453" },
        { chainId: "eip155:1" }
      );
      const row = response.results.find((r) => r.id === "chain-matches-intent");
      expect(row?.status).to.equal("FAIL");
      expect(row?.code).to.equal("SWAP_CHAIN_MISMATCH");
      expect(response.verdict).to.equal("DENY");
    });
  });

  describe("property loop: a clean swap fixture", () => {
    it("mutating any single Floor-relevant field never keeps proceed:true unless the mutated value is equal by value", () => {
      const base = makeSwapRequest();
      const basePolicy = makeSwapPolicy();
      const baseFacts = makeSwapFacts();

      const caseVariantRecipient =
        "0x" + APPROVED_RECIPIENT.slice(2).toUpperCase();

      const mutations: Array<{
        label: string;
        build: () => unknown;
        allowIsEarned?: boolean;
      }> = [
        {
          label: "recipient lowercase",
          build: () => ({
            ...base.action,
            recipient: APPROVED_RECIPIENT.toLowerCase(),
          }),
          allowIsEarned: true,
        },
        {
          label: "recipient case variant",
          build: () => ({ ...base.action, recipient: caseVariantRecipient }),
          allowIsEarned: true,
        },
        {
          label: "recipient not owner",
          build: () => ({
            ...base.action,
            recipient: "0x000000000000000000000000000000000c0ffee1",
          }),
        },
        {
          label: "target malformed",
          build: () => ({ ...base.action, target: "not-an-address" }),
        },
        {
          label: "target different router",
          build: () => ({
            ...base.action,
            target: "0x1111111111111111111111111111111111111111",
          }),
        },
        {
          label: "tokenIn malformed",
          build: () => ({
            ...base.action,
            tokenIn: { symbol: "USDC", contractAddress: "bad" },
          }),
        },
        {
          label: "tokenIn equals tokenOut",
          build: () => ({
            ...base.action,
            tokenIn: { ...base.action.tokenOut },
          }),
        },
        {
          label: "amountIn zero",
          build: () => ({ ...base.action, amountIn: "0" }),
        },
        {
          label: "amountIn over cap",
          build: () => ({ ...base.action, amountIn: "9999999" }),
        },
        {
          label: "quotedOut zero",
          build: () => ({ ...base.action, quotedOut: "0" }),
        },
        {
          label: "minOut over quote",
          build: () => ({ ...base.action, minOut: "1000001" }),
        },
        {
          label: "slippageBps mismatch",
          build: () => ({ ...base.action, slippageBps: 1 }),
        },
        {
          label: "deadline in the past",
          build: () => ({ ...base.action, deadline: SWAP_NOW - 1 }),
        },
        {
          label: "approvalAmount off by one",
          build: () => ({ ...base.action, approvalAmount: "1000001" }),
        },
        {
          label: "chainId mismatch",
          build: () => ({ ...base.action, chainId: "eip155:8453" }),
        },
        {
          label: "type mutated away",
          build: () => ({ ...base.action, type: "teleport" }),
        },
      ];

      let checked = 0;
      mutations.forEach(({ label, build, allowIsEarned }) => {
        const action = build();
        const response = consult(
          { action } as never,
          basePolicy,
          baseFacts as never
        );
        checked += 1;
        expect(response.proceed, label).to.equal(allowIsEarned ?? false);
        expect(response.proceed, label).to.equal(
          response.verdict === "ALLOW_UNDER_POLICY"
        );
        expect(response.support >= 0.8, label).to.equal(response.proceed);
        expect(response.band === "green", label).to.equal(response.proceed);
      });

      expect(checked).to.equal(mutations.length);
      expect(checked).to.be.greaterThan(10);
    });
  });
});
