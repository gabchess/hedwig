import { existsSync, readFileSync, writeFileSync } from "node:fs";

const RPC = {
  "eip155:1": "https://eth.drpc.org",
  "eip155:56": "https://bsc-mainnet.public.blastapi.io",
  "eip155:137": "https://polygon.drpc.org",
  "eip155:43114": "https://api.avax.network/ext/bc/C/rpc",
};

const INCIDENTS = [
  { slug: "lifi-2024-07", chainId: "eip155:1", token: "0xdAC17F958D2ee523a2206206994597C13D831ec7", owner: "0xABE45eA636df7Ac90Fb7D8d8C74a081b169F92eF", spender: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", block: 20318962, tx: "0xd82fe84e63b1aa52e1ce540582ee0895ba4a71ec5e7a632a3faa1aff3e763873", poc: "src/test/2024-07/Lifiprotocol_exp.sol" },
  { slug: "socket-2024-01", chainId: "eip155:1", token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", owner: "0x7d03149A2843E4200f07e858d6c0216806Ca4242", spender: "0x3a23F943181408EAC424116Af7b7790c94Cb97a5", block: 19021453, tx: "0xc6c3331fa8c2d30e1ef208424c08c039a89e510df2fb6ae31e5aa40722e28fd6", poc: "src/test/2024-01/SocketGateway_exp.sol" },
  { slug: "dexible-2023-02", chainId: "eip155:1", token: "0x4C19596f5aAfF459fA38B0f7eD92F11AE6543784", owner: "0x58f5F0684C381fCFC203D77B2BbA468eBb29B098", spender: "0xDE62E1b0edAa55aAc5ffBE21984D321706418024", block: 16646022, tx: "0x138daa4cbeaa3db42eefcec26e234fc2c89a4aa17d6b1870fc460b2856fd11a6", poc: "src/test/2023-02/Dexible_exp.sol" },
  { slug: "rubic-2022-12", chainId: "eip155:1", token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", owner: "0x6b8D6E89590E41Fa7484691fA372c3552E93e91b", spender: "0x3335A88bb18fD3b6824b59Af62b50CE494143333", block: 16260580, tx: "0x9a97d85642f956ad7a6b852cf7bed6f9669e2c2815f3279855acf7f1328e7d46", poc: "src/test/2022-12/Rubic_exp.sol" },
  { slug: "seneca-2024-02", chainId: "eip155:1", token: "0xB05cABCd99cf9a73b19805edefC5f67CA5d1895E", owner: "0x9CBF099ff424979439dFBa03F00B5961784c06ce", spender: "0x65c210c59B43EB68112b7a4f75C8393C36491F06", block: 19325936, tx: "0x23fcf9d4517f7cc39815b09b0a80c023ab2c8196c826c93b4100f2e26b701286", poc: "src/test/2024-02/Seneca_exp.sol" },
  { slug: "sushi-rp2-2023-04", chainId: "eip155:1", token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", owner: "0x31d3243CfB54B34Fc9C73e1CB1137124bD6B13E1", spender: "0x044b75f554b886A065b9567891e45c79542d7357", block: 17007841, tx: "0x04b166e7b4ab5105a8e9c85f08f6346de1c66368687215b0e0b58d6e5002bc32", poc: "src/test/2023-04/Sushi_Router_exp.sol" },
  { slug: "a152-2026-04", chainId: "eip155:1", token: "0xdAC17F958D2ee523a2206206994597C13D831ec7", owner: "0x1bD7e605A63Df5698fC96B2f9F41Aee1671bcf7a", spender: "0x2990A16D2C37163f26F86d7af219064Ba5CD5605", block: 24973581, tx: "0x57709a498f27c7219b634ae20e7d2cbf9ab8dd6aca7b3845fabf93b57760b576", poc: "src/test/2026-04/unverified_a152_exp.sol" },
  { slug: "squid-2026-04", chainId: "eip155:56", token: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", owner: "0xacc0c1f672b03b9a5fed4535f840f09b85f40e98", spender: "0xad6cea45f98444a922a2b4fe96b8c90f0862d2f4", block: 91122249, tx: "0x81d0c429ee7eae19d8c4d9d797dbd3828279060096e703b11cca739c9b1301e9", poc: "src/test/2026-04/SquidMulticallAllowanceDrain_exp.sol" },
  { slug: "safe-squat-2026-10", chainId: "eip155:43114", token: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", owner: "0x631FCa4a73AEe699638634479132452ef354b9B8", spender: "0x3725bD4D175283108156c3F15f86e1c51266155d", block: 98603854, tx: "0xf88a7960a07832e1bf5be64edbd12a9e615b4f63959a4b87a147f0c63c007ed5", approvalTx: "0x6952f80bbbcad4368b020bcda600965cf0a520a8694db431b6b1521842d3829e", poc: "src/test/2026-10/SafeApprovalSquat_exp.sol" },
  { slug: "gasless-enabler-2026-09", chainId: "eip155:137", token: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", owner: "0x2F785EF4f514F6b785Ab93062e05CfCC937faC96", spender: "0x9B58fDAdc16E30fBA313E044bf9e88689C3F163e", block: 94199849, tx: "0x2e476745f0f546dbe4583359ea6258dfb4fababea08734f676df2e6006e1fdee", poc: "src/test/2026-09/GaslessReservoirEnabler_exp.sol" },
];

async function rpc(chainId, method, params) {
  const res = await fetch(RPC[chainId], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

const word = (addr) => addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const hex = (n) => `0x${n.toString(16)}`;

function decodeString(result) {
  const bytes = result.replace(/^0x/, "");
  if (bytes.length >= 192) {
    const len = parseInt(bytes.slice(64, 128), 16);
    return Buffer.from(bytes.slice(128, 128 + len * 2), "hex").toString("utf8");
  }
  return Buffer.from(bytes, "hex").toString("utf8").replace(/\0/g, "");
}

const ONLY = process.argv[2] ? process.argv[2].split(",") : null;
const out = [];
for (const i of INCIDENTS.filter(x=>!ONLY||ONLY.includes(x.slug))) {
  try {
    const tag = hex(i.block);
    const allowance = BigInt(await rpc(i.chainId, "eth_call", [{ to: i.token, data: `0xdd62ed3e${word(i.owner)}${word(i.spender)}` }, tag])).toString();
    const symbol = decodeString(await rpc(i.chainId, "eth_call", [{ to: i.token, data: "0x95d89b41" }, tag]));
    const ownerCode = await rpc(i.chainId, "eth_getCode", [i.owner, tag]);
    const receipt = await rpc(i.chainId, "eth_getTransactionReceipt", [i.tx]);
    const row = {
      ...i,
      allowance,
      symbol,
      ownerIsContract: ownerCode !== "0x",
      attackTxStatus: receipt?.status ?? null,
      attackTxBlock: receipt ? parseInt(receipt.blockNumber, 16) : null,
    };
    if (i.approvalTx) {
      const atx = await rpc(i.chainId, "eth_getTransactionByHash", [i.approvalTx]);
      row.approvalTx = { hash: i.approvalTx, from: atx.from, to: atx.to, block: parseInt(atx.blockNumber, 16), inputPrefix: atx.input.slice(0, 10) };
    }
    out.push(row);
    console.log(i.slug, symbol, allowance, row.ownerIsContract ? "contract" : "eoa", row.attackTxStatus, row.attackTxBlock);
  } catch (e) {
    out.push({ ...i, error: String(e.message ?? e) });
    console.log(i.slug, "ERROR", String(e.message ?? e).slice(0, 200));
  }
}
// A slug list refreshes only those rows. Every other row stays as it was.
const OUT = new URL("./incidents.json", import.meta.url);
const rows = new Map(
  (existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : []).map((row) => [row.slug, row])
);
for (const row of out) rows.set(row.slug, row);
const merged = INCIDENTS.map((i) => rows.get(i.slug)).filter(Boolean);
writeFileSync(OUT, JSON.stringify(merged, null, 2));
