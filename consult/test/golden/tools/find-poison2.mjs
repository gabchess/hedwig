const RPC = "https://eth.drpc.org";
async function rpc(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const b = await res.json(); if (b.error) throw new Error(`${method}: ${JSON.stringify(b.error)}`); return b.result;
}
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const victim = "0x1e227979f0b5bc691a70deaed2e0f39a6f538fd5";
const pad = (a) => `0x${a.slice(2).padStart(64, "0")}`;
for (let f = 19788556; f <= 19789150; f += 100) {
  for (const topics of [[TRANSFER, pad(victim)], [TRANSFER, null, pad(victim)]]) {
    const logs = await rpc("eth_getLogs", [{ fromBlock: `0x${f.toString(16)}`, toBlock: `0x${Math.min(f + 99, 19789150).toString(16)}`, topics }]);
    for (const l of logs) console.log(parseInt(l.blockNumber, 16), l.transactionHash, "token", l.address, "from", `0x${l.topics[1].slice(26)}`, "to", `0x${l.topics[2].slice(26)}`, BigInt(l.data === "0x" ? 0 : l.data).toString());
  }
}
const tx = await rpc("eth_getTransactionByHash", ["0x3374abc5a9c766ba709651399b6e6162de97ca986abc23f423a9d893c8f5f570"]);
const rc = await rpc("eth_getTransactionReceipt", ["0x3374abc5a9c766ba709651399b6e6162de97ca986abc23f423a9d893c8f5f570"]);
console.log(JSON.stringify({ from: tx.from, to: tx.to, value: BigInt(tx.value).toString(), data: tx.input, block: parseInt(tx.blockNumber, 16), status: rc.status }));
