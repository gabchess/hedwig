import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { consult } from "../../../src";

const TOOLS = __dirname;
const GOLDEN_PATH = join(TOOLS, "..", "golden-cases.json");
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
const incidents = JSON.parse(
  readFileSync(join(TOOLS, "incidents.json"), "utf8")
);

const RETRIEVED = "2026-10-30";
const DHL_SHA = "d4bd931e758a375ed7fcecf52322dfeab54f8c0d";
const dhl = (path: string, lines: string) =>
  `https://github.com/SunWeb3Sec/DeFiHackLabs/blob/${DHL_SHA}/${path}#${lines}`;
const RPC_NAME: Record<string, string> = {
  "eip155:1": "https://eth.drpc.org",
  "eip155:56": "https://bsc-mainnet.public.blastapi.io",
  "eip155:137": "https://polygon.drpc.org",
  "eip155:43114": "https://api.avax.network/ext/bc/C/rpc",
};
const NOW = 2000000000;
const SOFT_OUTCOME_GAP =
  "a careful payer would prefer a FAIL, so this is a known product gap.";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}
const policyHash = (policy: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(sortKeys(policy)))
    .digest("hex");
const ids = (rows: readonly { id: string; status: string }[], status: string) =>
  rows
    .filter((r) => r.status === status)
    .map((r) => r.id)
    .sort();

function finish(c: any) {
  const r = consult(c.input.request, c.input.policy, c.input.facts);
  c.expected = {
    verdict: r.verdict,
    proceed: r.proceed,
    band: r.band,
    failIds: ids(r.results, "FAIL"),
    unverifiedIds: ids(r.results, "UNVERIFIED"),
  };
  c.policySha256 = policyHash(c.input.policy);
  return c;
}

function swapPolicy(chainId: string, owner: string, capAsset: string) {
  return {
    permits: true,
    chainId,
    approvedRecipients: [owner],
    perActionCaps: { swap: "1000000" },
    perActionCapAssets: { swap: capAsset },
    maxSlippageBps: 100,
    maxDeadlineSeconds: 600,
    ownerAddresses: [owner],
    role: { mode: "not-required" },
  };
}

const TOKEN_OUT: Record<string, { symbol: string; contractAddress: string }> = {
  "eip155:1": {
    symbol: "WETH",
    contractAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
  "eip155:56": {
    symbol: "USDC",
    contractAddress: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  },
  "eip155:137": {
    symbol: "USDC",
    contractAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  },
  "eip155:43114": {
    symbol: "WAVAX",
    contractAddress: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
  },
};

const INCIDENT_META: Record<
  string,
  { id: string; name: string; lines: string; lineRef: string }
> = {
  "lifi-2024-07": {
    id: "swap-real-lifi-2024-unlimited-approval-denies",
    name: "LI.FI diamond, July 2024",
    lines: "L37-L39",
    lineRef:
      "src/test/2024-07/Lifiprotocol_exp.sol lines 37 to 39 name the LiFiDiamond and the victim",
  },
  "socket-2024-01": {
    id: "swap-real-socket-2024-unlimited-approval-denies",
    name: "Socket Gateway route, January 2024",
    lines: "L38-L41",
    lineRef:
      "src/test/2024-01/SocketGateway_exp.sol lines 38 to 41 name the gateway and the target user",
  },
  "dexible-2023-02": {
    id: "swap-real-dexible-2023-standing-approval-denies",
    name: "Dexible, February 2023",
    lines: "L45-L46",
    lineRef:
      "src/test/2023-02/Dexible_exp.sol lines 45 and 46 name the Dexible contract and the victim",
  },
  "rubic-2022-12": {
    id: "swap-real-rubic-2022-unlimited-approval-denies",
    name: "Rubic proxy, December 2022",
    lines: "L49-L61",
    lineRef:
      "src/test/2022-12/Rubic_exp.sol line 49 names RubicProxy1 and line 61 names victims[0]",
  },
  "seneca-2024-02": {
    id: "swap-real-seneca-2024-unlimited-approval-denies",
    name: "Seneca Chamber, February 2024",
    lines: "L24-L26",
    lineRef:
      "src/test/2024-02/Seneca_exp.sol lines 24 to 26 name the Chamber and the victim",
  },
  "a152-2026-04": {
    id: "swap-real-a152-2026-standing-approval-denies",
    name: "unverified AllowanceTarget 0x2990, April 2026",
    lines: "L27-L37",
    lineRef:
      "src/test/2026-04/unverified_a152_exp.sol line 27 names ALLOWANCE_TARGET and line 37 names USDT_OWNER_TWO",
  },
  "squid-2026-04": {
    id: "swap-real-squid-multicall-2026-unlimited-approval-denies",
    name: "SquidMulticall on BNB Chain, April 2026",
    lines: "L26-L28",
    lineRef:
      "src/test/2026-04/SquidMulticallAllowanceDrain_exp.sol lines 26 to 28 name SquidMulticall, the victim and the token",
  },
  "safe-squat-2026-10": {
    id: "swap-real-safe-approval-squat-2026-unlimited-approval-denies",
    name: "Safe approval squat on Avalanche, October 2026",
    lines: "L64-L71",
    lineRef:
      "src/test/2026-10/SafeApprovalSquat_exp.sol lines 64 and 65 name the Safe and the pre-approved address, line 71 names USDC",
  },
  "gasless-enabler-2026-09": {
    id: "swap-real-gasless-enabler-2026-unlimited-approval-denies",
    name: "GaslessReservoirEnabler on Polygon, September 2026",
    lines: "L45-L89",
    lineRef:
      "src/test/2026-09/GaslessReservoirEnabler_exp.sol line 45 names the enabler and line 89 names the largest victim",
  },
};

const errorRows = incidents.filter((row: any) => row.error !== undefined);
if (errorRows.length > 0)
  throw new Error(
    `incidents.json has error rows: ${errorRows.map((row: any) => row.slug).join(", ")}`
  );
const fetchedSlugs = new Set(incidents.map((row: any) => row.slug));
const missingSlugs = Object.keys(INCIDENT_META).filter(
  (slug) => !fetchedSlugs.has(slug)
);
if (missingSlugs.length > 0)
  throw new Error(`incidents.json is missing ${missingSlugs.join(", ")}`);

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
const POISON_VICTIM = "0x1e227979f0b5bc691a70deaed2e0f39a6f538fd5";
const POISON_INTENDED = "0xd9a1b0b1e1ae382dbdc898ea68012ffcb2853a91";
const POISON_LOOKALIKE = "0xd9a1c3788d81257612e2581a6ea0ada244853a91";
const SPOOF_TOKEN = "0x739352337c902c3874b95f14e81ebbcf1b7b262e";
const WBTC_POISONING_ID = "pay-real-wbtc-address-poisoning-denies";
const EXPECTED_ORIGIN =
  "consult() output, then independently agreed by the verifier";
// These cases pin what consult() returns today, which is not what a careful
// payer wants, so no verifier agreement can make them ground truth.
const KNOWN_GAPS: Record<string, { desired: string; reason: string }> = {
  "pay-real-spoof-eth-token-stays-unknown": {
    desired: "FAIL",
    reason:
      "A spoof token that claims the ETH symbol gets UNVERIFIED token checks and an UNKNOWN verdict instead of a FAIL.",
  },
  "swap-real-spoof-eth-token-out-stays-unknown": {
    desired: "FAIL",
    reason:
      "A spoof ETH output token gets UNVERIFIED on token-out-is-canonical and an UNKNOWN verdict instead of a FAIL.",
  },
  [WBTC_POISONING_ID]: {
    desired: "FAIL",
    reason:
      "recipient-not-poison-derived passes on the lookalike of an address the victim paid minutes earlier, and only recipient-matches-policy fails.",
  },
};
const CHAINALYSIS = "https://www.chainalysis.com/blog/address-poisoning-scam";
const CHAINALYSIS_QUOTE =
  "The event begins with an initial transfer on 3 May 2024 at 9:14 UTC from the victim (0x1E227) to 0xd9A1b, a seemingly benign address on the Ethereum blockchain. ... the victim made a second transfer, this time unknowingly to an address controlled by the scammer, 0xd9A1c";
const payPolicy = (recipient: string, capAsset: string, cap: string) => ({
  permits: true,
  chainId: "eip155:1",
  approvedRecipients: [recipient],
  perActionCaps: { pay: cap },
  perActionCapAssets: { pay: capAsset },
  role: { mode: "not-required" },
  authorizationWindow: { mode: "not-required" },
});
const transferData = (to: string, amount: string) =>
  `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, "0")}${BigInt(amount)
    .toString(16)
    .padStart(64, "0")}`;

const BINANCE = JSON.parse(readFileSync(join(TOOLS, "transfer.json"), "utf8"));
const transferRecipient = `0x${BINANCE.data.slice(34, 74)}`;
const transferAmount = BigInt(`0x${BINANCE.data.slice(74)}`).toString();

const replacements: Record<string, any> = {
  "pay-clean-direct-transfer-allows": {
    description: `Real transfer: ${BINANCE.hash}, a direct transfer of 40 USDC signed by the externally owned account ${BINANCE.from}, which succeeded on ${BINANCE.time}. Its benign label rests only on that on-chain outcome. The policy approves the call's recipient and caps pay at the call's amount.`,
    label_source: {
      url: `https://etherscan.io/tx/${BINANCE.hash}`,
      kind: "onchain",
      quote: `receipt status ${BINANCE.status}; transfer(${transferRecipient}, ${transferAmount}) on the USDC contract, block ${BINANCE.block}`,
      retrieved: RETRIEVED,
    },
    chain_evidence: [
      {
        chainId: "eip155:1",
        rpc: RPC_NAME["eip155:1"],
        method: "eth_getTransactionByHash",
        call: BINANCE.hash,
        block: BINANCE.block,
        result: `from ${BINANCE.from} to ${BINANCE.to} status ${BINANCE.status}`,
      },
    ],
    input: {
      request: {
        action: {
          type: "pay",
          chainId: "eip155:1",
          recipient: transferRecipient,
          asset: { symbol: "USDC", contractAddress: USDC },
          amount: transferAmount,
          target: USDC,
        },
        transaction: {
          from: BINANCE.from,
          to: BINANCE.to,
          value: BINANCE.value,
          data: BINANCE.data,
        },
      },
      policy: payPolicy(transferRecipient, USDC, transferAmount),
      facts: { now: NOW },
    },
  },
  "NEW:pay-real-spoof-eth-token-stays-unknown": {
    description: `Real spoof token from the 3 May 2024 address poisoning: contract 0x7393 reports symbol ETH, name Ether and 6 decimals. Its Transfer log moved 50000 units from the victim to the lookalike 0xd9a1c378. The call bytes are rebuilt from that log; the original transaction was sent by the attacker, not signed by the victim. The catalog has no ETH token entry, so the token checks answer UNVERIFIED and the verdict is UNKNOWN, not DENY. Hedwig's current rules give a soft outcome here (UNKNOWN), and ${SOFT_OUTCOME_GAP}`,
    label_source: {
      url: "https://cointelegraph.com/news/address-poisoning-attacker-sends-153-k-ethereum-negotiate",
      kind: "incident",
      quote:
        "the token had a custom design that allowed it to be transferred from an account without the user's consent",
      retrieved: RETRIEVED,
    },
    chain_evidence: [
      {
        chainId: "eip155:1",
        rpc: RPC_NAME["eip155:1"],
        method: "eth_getLogs",
        call: "Transfer logs from 0x1e227979 in blocks 19788556 to 19789150",
        block: 19788642,
        result:
          "tx 0x9147d74ef5749b7f27eb2e2528e5a611060b3f609b435f7f50ac87f49e5b957c token 0x739352337c902c3874b95f14e81ebbcf1b7b262e to 0xd9a1c378 amount 50000",
      },
      {
        chainId: "eip155:1",
        rpc: RPC_NAME["eip155:1"],
        method: "eth_call",
        call: "0x739352337c902c3874b95f14e81ebbcf1b7b262e symbol(), name(), decimals()",
        block: 19789265,
        result: "ETH, Ether, 6",
      },
    ],
    input: {
      request: {
        action: {
          type: "pay",
          chainId: "eip155:1",
          recipient: POISON_LOOKALIKE,
          asset: { symbol: "ETH", contractAddress: SPOOF_TOKEN },
          amount: "50000",
          target: SPOOF_TOKEN,
        },
        transaction: {
          from: POISON_VICTIM,
          to: SPOOF_TOKEN,
          value: "0",
          data: transferData(POISON_LOOKALIKE, "50000"),
        },
      },
      policy: payPolicy(POISON_LOOKALIKE, USDC, "1000000"),
      facts: { now: NOW },
    },
  },
  "NEW:swap-real-spoof-eth-token-out-stays-unknown": {
    description: `Output token is the real spoof token 0x7393 (symbol ETH, name Ether, 6 decimals) from the 3 May 2024 address poisoning. Amounts, quote, deadline and owner are synthetic. The catalog has no ETH token entry, so token-out-is-canonical answers UNVERIFIED and the verdict is UNKNOWN, not DENY. Hedwig's current rules give a soft outcome here (UNKNOWN), and ${SOFT_OUTCOME_GAP}`,
    label_source: {
      url: "https://cointelegraph.com/news/address-poisoning-attacker-sends-153-k-ethereum-negotiate",
      kind: "incident",
      quote:
        'The token transferred had no name listed on Etherscan and was simply referred to as "ERC-20."',
      retrieved: RETRIEVED,
    },
    chain_evidence: [
      {
        chainId: "eip155:1",
        rpc: RPC_NAME["eip155:1"],
        method: "eth_call",
        call: "0x739352337c902c3874b95f14e81ebbcf1b7b262e symbol(), name(), decimals()",
        block: 19789265,
        result: "ETH, Ether, 6",
      },
    ],
    tokenOut: { symbol: "ETH", contractAddress: SPOOF_TOKEN },
  },
  "swap-non-canonical-router-denies": {
    description:
      "Swap target is SushiSwap RouteProcessor2 0x044b, the router drained in April 2023, not the pinned router for the chain. Amounts, quote, deadline and owner are synthetic.",
    label_source: {
      url: dhl("src/test/2023-04/Sushi_Router_exp.sol", "L46-L47"),
      kind: "repo",
      line_ref:
        "src/test/2023-04/Sushi_Router_exp.sol line 47 names RouteProcessor2 0x044b75f554b886A065b9567891e45c79542d7357",
      retrieved: RETRIEVED,
    },
    chain_evidence: [
      {
        chainId: "eip155:1",
        rpc: RPC_NAME["eip155:1"],
        method: "eth_getTransactionReceipt",
        call: "0x04b166e7b4ab5105a8e9c85f08f6346de1c66368687215b0e0b58d6e5002bc32",
        block: 17007842,
        result: "status 0x1",
      },
    ],
    target: "0x044b75f554b886A065b9567891e45c79542d7357",
  },
};

// The builder rewrites its own output in place, so the cases it generates are
// dropped and rebuilt. Review results are not build output: they carry over
// by id from the file being rewritten.
const generatedIds = new Set([
  ...Object.values(INCIDENT_META).map((m) => m.id),
  WBTC_POISONING_ID,
  ...Object.keys(replacements)
    .filter((key) => key.startsWith("NEW:"))
    .map((key) => key.slice(4)),
]);
const previous = new Map<string, any>(
  JSON.parse(JSON.stringify(golden.cases)).map((c: any) => [c.id, c])
);
golden.cases = golden.cases.filter((c: any) => !generatedIds.has(c.id));

const newCases: any[] = [];
for (const inc of incidents) {
  const meta = INCIDENT_META[inc.slug];
  if (!meta) continue;
  const action = {
    type: "swap",
    chainId: inc.chainId,
    target: inc.spender,
    tokenIn: { symbol: inc.symbol, contractAddress: inc.token },
    tokenOut: TOKEN_OUT[inc.chainId],
    amountIn: "1000000",
    quotedOut: "1000000",
    minOut: "995000",
    slippageBps: 50,
    deadline: NOW + 300,
    recipient: inc.owner,
    approvalAmount: inc.allowance,
  };
  const evidence: any[] = [
    {
      chainId: inc.chainId,
      rpc: RPC_NAME[inc.chainId],
      method: "eth_call",
      call: `${inc.token}.allowance(${inc.owner}, ${inc.spender})`,
      block: inc.block,
      result: inc.allowance,
    },
    {
      chainId: inc.chainId,
      rpc: RPC_NAME[inc.chainId],
      method: "eth_getTransactionReceipt",
      call: inc.tx,
      block: inc.attackTxBlock,
      result: `status ${inc.attackTxStatus}`,
    },
  ];
  if (inc.approvalTx) {
    evidence.push({
      chainId: inc.chainId,
      rpc: RPC_NAME[inc.chainId],
      method: "eth_getTransactionByHash",
      call: inc.approvalTx.hash,
      block: inc.approvalTx.block,
      result: `from ${inc.approvalTx.from} to ${inc.approvalTx.to} selector ${inc.approvalTx.inputPrefix}`,
    });
  }
  newCases.push(
    finish({
      id: meta.id,
      description: `Real incident: ${meta.name}. The owner, the target (the drained spender), the input token and the approval amount are the victim's on-chain values read at the fork block of the DeFiHackLabs proof of concept. Amounts, quote, deadline and output token are synthetic.`,
      label_source: {
        url: dhl(inc.poc, meta.lines),
        kind: "repo",
        line_ref: meta.lineRef,
        retrieved: RETRIEVED,
      },
      chain_evidence: evidence,
      reviewed: false,
      input: {
        request: { action },
        policy: swapPolicy(inc.chainId, inc.owner, inc.token),
        facts: { now: NOW },
      },
    })
  );
}

newCases.push(
  finish({
    id: WBTC_POISONING_ID,
    description: `Real incident: the 3 May 2024 address poisoning. The call bytes are the victim's signed WBTC transfer of 1155.28802767 WBTC to the lookalike 0xd9a1c378. The policy approves only the address the victim test-paid 0.05 ETH minutes earlier, 0xd9a1b0b1. Hedwig's current rules give a soft outcome on the poisoning itself (recipient-not-poison-derived passes, and only recipient-matches-policy fails), and ${SOFT_OUTCOME_GAP}`,
    label_source: {
      url: CHAINALYSIS,
      kind: "incident",
      quote: CHAINALYSIS_QUOTE,
      retrieved: RETRIEVED,
    },
    chain_evidence: [
      {
        chainId: "eip155:1",
        rpc: RPC_NAME["eip155:1"],
        method: "eth_getTransactionByHash",
        call: "0x3374abc5a9c766ba709651399b6e6162de97ca986abc23f423a9d893c8f5f570",
        block: 19789009,
        result:
          "from 0x1e227979 to WBTC, transfer(0xd9a1c378..., 115528802767), receipt status 0x1",
      },
      {
        chainId: "eip155:1",
        rpc: RPC_NAME["eip155:1"],
        method: "eth_getTransactionByHash",
        call: "0xb18ab131d251f7429c56a2ae2b1b75ce104fe9e83315a0c71ccf2b20267683ac",
        block: 19788628,
        result:
          "from 0x1e227979 to 0xd9a1b0b1e1ae382dbdc898ea68012ffcb2853a91 value 50000000000000000",
      },
    ],
    reviewed: false,
    input: {
      request: {
        action: {
          type: "pay",
          chainId: "eip155:1",
          recipient: POISON_LOOKALIKE,
          asset: { symbol: "WBTC", contractAddress: WBTC },
          amount: "115528802767",
          target: WBTC,
        },
        transaction: {
          from: POISON_VICTIM,
          to: WBTC.toLowerCase(),
          value: "0",
          data: transferData(POISON_LOOKALIKE, "115528802767"),
        },
      },
      policy: payPolicy(POISON_INTENDED, WBTC, "115528802767"),
      facts: { now: NOW },
    },
  })
);

const baseSwap = golden.cases.find(
  (c: any) => c.id === "swap-lookalike-token-out-denies"
);
for (const [key, r] of Object.entries(replacements)) {
  if (!key.startsWith("NEW:")) continue;
  golden.cases.push({
    id: key.slice(4),
    description: "",
    label_source: null,
    reviewed: false,
    input: r.input ?? JSON.parse(JSON.stringify(baseSwap.input)),
  });
}
for (const c of golden.cases) {
  const r = replacements[c.id] ?? replacements[`NEW:${c.id}`];
  if (!r) continue;
  c.description = r.description;
  c.label_source = r.label_source;
  c.chain_evidence = r.chain_evidence;
  if (r.input) c.input = r.input;
  if (r.tokenOut) c.input.request.action.tokenOut = r.tokenOut;
  if (r.target) c.input.request.action.target = r.target;
  finish(c);
}

const existing = new Set(golden.cases.map((c: any) => c.id));
for (const c of newCases)
  if (existing.has(c.id)) throw new Error(`duplicate ${c.id}`);
golden.cases.push(...newCases);
const canonical = (value: unknown) => JSON.stringify(sortKeys(value));
for (const c of golden.cases) {
  const gap = KNOWN_GAPS[c.id];
  if (gap) {
    c.reviewed = false;
    delete c.review;
    delete c.expected_origin;
    c.known_gap = gap;
    continue;
  }
  const prior = previous.get(c.id);
  if (prior?.reviewed !== true) continue;
  if (
    canonical(prior.input) !== canonical(c.input) ||
    canonical(prior.expected) !== canonical(c.expected)
  )
    throw new Error(
      `${c.id} changed since the verifier agreed it; remove its review and have it reviewed again`
    );
  c.reviewed = true;
  c.review = prior.review;
  c.expected_origin = EXPECTED_ORIGIN;
}

const { schemaVersion, policyVersion, fields, floorIds, cases } = golden;
const out = {
  schemaVersion,
  policyVersion,
  notice:
    "Labels are confirmed by their cited public source plus an independent verifier model, per the 2026-10-30 change to Hedwig ADR H-0001. No named person reviews labels. Every expected block is consult() output, so by itself it only pins current behavior and is not ground truth. A case counts as ground truth only when reviewed is true, which means a verifier model that did not write the case opened its label_source, matched the quote or line reference, replayed its chain_evidence reads, and independently agreed the expected verdict, band and check ids. The review object on that case records who confirmed it, when and how, and expected_origin records where expected came from. A case with known_gap pins current behavior that a careful payer would not want. known_gap names the desired outcome and the reason, and such a case stays reviewed false. Cases with a string label_source were written by an agent from THREAT-MODEL.md, consult/README.md and the test fixtures; they cite no independent source and must stay reviewed false. Cases with a label_source object cite a public incident write-up, repository, paper or on-chain record retrieved on or before labelCutoff, and never a list the catalog imports. Their synthetic fields are named in the description. consult/test/golden/tools/build-golden.ts rebuilds the source-grounded cases.",
  labelCutoff: "2026-10-30",
  fields: {
    ...fields,
    label_source:
      "A string for an agent-written label. An object { url, kind, quote or line_ref, retrieved } for a label grounded in a public source. kind is incident, repo, paper or onchain.",
    chain_evidence:
      "Optional. Each public RPC read used to build the case: chainId, rpc, method, call, block and result, so a verifier can repeat it without an API key.",
    reviewed:
      "false until an independent verifier model confirms the label against label_source and agrees the expected verdict, band and check ids. true is allowed only with a label_source object, a review object and expected_origin, and never with known_gap.",
    review:
      "Present only when reviewed is true. { by, date, method } names the verifier, the date it confirmed the label (on or before labelCutoff) and what it checked. The verifier never wrote the case.",
    expected_origin:
      "Present only when reviewed is true. States that expected is consult() output that the verifier then agreed independently.",
    known_gap:
      "Optional. { desired, reason } on a case whose expected pins current behavior that a careful payer would not want. A case with known_gap stays reviewed false.",
  },
  floorIds,
  cases,
};
writeFileSync(GOLDEN_PATH, `${JSON.stringify(out, null, 2)}\n`);
for (const c of golden.cases) {
  if (typeof c.label_source === "object")
    console.log(
      c.id,
      c.reviewed ? "reviewed" : "unreviewed",
      c.expected.verdict,
      c.expected.band,
      "FAIL",
      c.expected.failIds.join(","),
      "UNV",
      c.expected.unverifiedIds.join(",")
    );
}
