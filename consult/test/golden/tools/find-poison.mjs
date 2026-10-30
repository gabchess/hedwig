const RPC = "https://eth.drpc.org";
async function rpc(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const b = await res.json();
  if (b.error) throw new Error(`${method}: ${JSON.stringify(b.error)}`);
  return b.result;
}
const ts = async (n) => parseInt((await rpc("eth_getBlockByNumber", [`0x${n.toString(16)}`, false])).timestamp, 16);
async function blockAt(t) {
  let lo = 19000000, hi = 20500000;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if ((await ts(mid)) < t) lo = mid; else hi = mid; }
  return hi;
}
const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const victim = "0x1e227979f0b5bc691a70deaed2e0f39a6f538fd5";
const start = await blockAt(Date.parse("2024-05-03T09:00:00Z") / 1000);
const end = await blockAt(Date.parse("2024-05-03T11:00:00Z") / 1000);
console.log("blocks", start, end);
for (let f = start; f <= end; f += 100) { const logs = await rpc("eth_getLogs", [{ address: WBTC, fromBlock: `0x${f.toString(16)}`, toBlock: `0x${Math.min(f + 99, end).toString(16)}`, topics: [TRANSFER, `0x${victim.slice(2).padStart(64, "0")}`] }]); for (const l of logs) console.log(l.transactionHash, parseInt(l.blockNumber, 16), "to", `0x${l.topics[2].slice(26)}`, BigInt(l.data).toString()); }
const s2 = await blockAt(Date.parse("2024-05-03T09:10:00Z") / 1000);
for (let n = s2; n < s2 + 60; n++) {
  const b = await rpc("eth_getBlockByNumber", [`0x${n.toString(16)}`, true]);
  for (const t of b.transactions) if (t.from.toLowerCase() === victim) console.log("victim tx", n, t.hash, "to", t.to, "value", BigInt(t.value).toString(), "input", t.input.slice(0, 138));
}
