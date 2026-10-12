---
name: ask
description: Ask Hedwig before you pay. Use it before you sign, send or approve a token payment for the owner. Hedwig checks the payment against the owner's limits and says why. It never signs or sends.
allowed-tools: mcp__plugin_hedwig_hedwig__consult
---

# Ask Hedwig before you pay

Prepare the payment. Don't sign or send it. Call the `consult` tool from the `hedwig` server once and wait for the answer.

Use Hedwig for ERC-20 payments on Ethereum and Base. For any other action, tell the owner and stop.

## Build the request

Send one argument, `request`, with the `action` and the unsigned `transaction` you plan to send. This one pays 1 USDC to the sample address:

```json
{
  "request": {
    "action": {
      "type": "pay",
      "chainId": "eip155:1",
      "recipient": "0x00000000000000000000000000000000a11ce001",
      "asset": {
        "symbol": "USDC",
        "contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
      },
      "amount": "1000000",
      "target": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    },
    "transaction": {
      "from": "0x00000000000000000000000000000000b0b00002",
      "to": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "value": "0",
      "data": "0xa9059cbb00000000000000000000000000000000000000000000000000000000a11ce00100000000000000000000000000000000000000000000000000000000000f4240"
    }
  }
}
```

- `amount` is a whole number in the token's base units. USDC has 6 decimals, so 1 USDC is `"1000000"` and 50 USDC is `"50000000"`. Never write `"50"` for 50 USDC.
- `target` and `transaction.to` are the token contract. The recipient goes in `action.recipient` and inside the calldata.
- `transaction.data` is the ERC-20 `transfer` call. This line builds it for any amount:

  ```sh
  node -p "'0xa9059cbb' + process.argv[1].slice(2).padStart(64, '0') + BigInt(process.argv[2]).toString(16).padStart(64, '0')" "$RECIPIENT" "$AMOUNT"
  ```

- Use the same recipient, token and amount in `action` and `transaction`.

## Read the answer

- `proceed: true`: the payment fits the owner's limits. Say "Hedwig says go" and give the reason in one plain sentence. The owner decides.
- `proceed: false`: stop. Say "Hedwig says no" and give the `evidence` of the first row in `results` whose `status` is not `PASS`.

Don't call the payment safe or approved. Don't paste the JSON. If the owner asks why, list the rows in plain words.

After a no, don't change the payment to get a yes. Don't edit the limits file or restart the server.

## If Hedwig is missing

If `consult` is missing or returns an error, ask the owner to run `/mcp` and check that `hedwig` is connected. It needs Node.js 22 or newer.

## Sample limits

The sample limits allow alice (`0x00000000000000000000000000000000a11ce001`) to receive up to 1 USDC per payment on Ethereum (`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`). When the owner says alice, use that address. The sample addresses are placeholders. Never sign or send a payment to one.
