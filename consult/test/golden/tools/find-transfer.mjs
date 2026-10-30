const RPC = "https://eth.drpc.org";
const rpc = async (m, p) => { const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json(); if (r.error) throw new Error(JSON.stringify(r.error)); return r.result; };
const hex = (n) => `0x${n.toString(16)}`;
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const b = await rpc("eth_getBlockByNumber", [hex(26298232), true]);
for (const tx of b.transactions) {
  if (tx.to?.toLowerCase() !== USDC || !/^0xa9059cbb0{24}[0-9a-f]{40}[0-9a-f]{64}$/i.test(tx.input) || tx.value !== "0x0") continue;
  const code = await rpc("eth_getCode", [tx.from, b.number]);
  const amount = BigInt(`0x${tx.input.slice(74)}`);
  if (code !== "0x" || amount < 1000000n) continue;
  console.log(tx.hash);
  break;
}
