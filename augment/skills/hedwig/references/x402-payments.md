# x402 payments

x402 is an open payment standard that carries a payment inside an ordinary
request and response cycle, built around the HTTP `402 Payment Required`
status code. Its terms arrive as named fields, so a caller holding a 402
response maps them into a Hedwig `pay` request and consults the owner's
policy before signing.

## The 402 exchange

1. The client requests a resource from a resource server.
2. The server answers `402 Payment Required` with a `PaymentRequired` object,
   as Base64 JSON in a `PAYMENT-REQUIRED` header or as a JSON body.
3. The client selects one entry from `accepts`, builds a `PaymentPayload` for
   that entry's `scheme` and `network`, and repeats the request with it in the
   payment header, named `PAYMENT-SIGNATURE` in v2 and `X-PAYMENT` in v1.
4. The server verifies locally, or posts `paymentPayload` and
   `paymentRequirements` to the facilitator's `POST /verify`, which answers
   `isValid` with an optional `invalidReason` and `payer`. It then settles on
   chain directly, or through `POST /settle`, whose response carries
   `success`, `transaction`, `network` and an optional `amount`.
5. The server returns `200 OK` with the resource as the body and the
   settlement response in a `PAYMENT-RESPONSE` header as Base64 JSON.

## The fields of a payment requirement

Each object in the `accepts` array carries these fields in v2:

- `scheme`: the payment scheme identifier, for example `exact`.
- `network`: the network identifier in CAIP-2 `namespace:reference` format,
  for example `eip155:8453`. v1 uses short names such as `base-sepolia`.
- `amount`: the required payment amount in atomic token units. v1 names this
  same field `maxAmountRequired`.
- `asset`: the token contract address, or an ISO 4217 currency code for fiat.
- `payTo`: the recipient wallet address, or a role constant such as `merchant`.
- `maxTimeoutSeconds`: the maximum time allowed for payment completion.
- `extra`: optional scheme-specific data, such as a token `name` and `version`.

v2 carries the resource information in a top-level `resource` object of
`url`, `description` and `mimeType`; v1 keeps `resource`, `description`,
`mimeType` and `outputSchema` inside each requirement. The facilitator
verifies and settles payments; its `GET /supported` endpoint lists the scheme
and network pairs it implements.

## What the exact scheme signs on EVM

The `exact` scheme uses EIP-3009 `transferWithAuthorization` for gasless
transfers of a specific amount of an ERC-20 token. The client signs an
EIP-712 `TransferWithAuthorization` struct of `from`, `to`, `value`,
`validAfter`, `validBefore` and `nonce`, and the payload carries that
`signature` beside an `authorization` object holding the same values. The
facilitator validates the signature, confirms the payer's balance, checks the
amount and the time window, matches the authorization parameters against the
original requirements, and simulates the transfer. v2 requires the amount to
match exactly; v1 requires it to meet or exceed. Settlement calls
`transferWithAuthorization` on the ERC-20 contract with the signature and
those parameters. Each authorization carries a 32-byte random nonce and an
explicit valid window, and EIP-3009 contracts reject a reused nonce.

Three things move between the reading of a requirement and settlement.
`accepts` lists several methods, and in v2 the client echoes its choice as
`accepted` inside the `PaymentPayload`. A Bazaar discovery entry carries a
`lastUpdated` timestamp and changes dynamically, so it can differ from what
the server returns on the request itself. Under the `upto` scheme, v2 records
that `amount` is the maximum authorized amount at verification time and the
amount to settle at settlement time.

## What Hedwig reads

The caller maps the 402 fields into Hedwig's request shape and then calls
`consult(request, policy, facts)`. `consult()` makes no network call and reads
no clock, so it reads the mapped fields, the owner's policy, and the facts the
caller supplies as data.

- `request.action.recipient` is the requirement's `payTo`.
- `request.action.asset.contractAddress` is the requirement's `asset`, and
  `request.action.asset.symbol` is the caller's name for that token.
- `request.action.amount` is the requirement's `amount`, the field v1 names
  `maxAmountRequired`, in atomic units.
- `request.action.chainId` is the requirement's `network` as a CAIP-2 id. A
  v2 network is already a CAIP-2 id; a v1 short name is mapped by the caller.
- `request.action.target` is the contract the transaction calls, which for
  `exact` on EVM is the asset's own ERC-20 contract.

Every Floor Condition for `pay` then runs against those mapped fields:
`recipient-matches-policy` and `recipient-not-poison-derived` read the
recipient; `asset-is-canonical` and `target-is-canonical` read the asset
contract and the called contract against the canonical registry;
`amount-within-cap` reads the amount against the owner's cap;
`chain-matches-intent` reads the chain id; `role-requirement-met` reads the
owner's role choice and the `solanaRole` fact. Each row's question and codes
are in [Conditions](conditions.md).

## What PASS, FAIL and UNVERIFIED mean here

- PASS: the checker ran and the answer to its question is yes, for example a
  `payTo` that matches an approved entry.
- FAIL: the checker ran and the answer is no, for example an `asset` that is
  not the canonical contract for that chain and symbol. One FAIL on any row
  makes the verdict `DENY`.
- UNVERIFIED: the checker could not answer, for example a `network` that is
  not a well-formed CAIP-2 id, or a chain and symbol with no registry entry.
  A Floor row that is UNVERIFIED makes the verdict `UNKNOWN`, and any
  UNVERIFIED Floor row blocks an allow.

`ALLOW_UNDER_POLICY`, and with it `proceed: true`, needs a non-empty,
all-PASS result set and a policy whose `permits` is true. The signature, the
nonce and the time window are read by the facilitator's verification steps,
not by a Condition.

## Sources

- x402 Protocol Specification, protocol version 2:
  https://raw.githubusercontent.com/coinbase/x402/main/specs/x402-specification-v2.md
- x402 Protocol Specification, protocol version 1, for the v1 field names:
  https://raw.githubusercontent.com/coinbase/x402/main/specs/x402-specification-v1.md
- x402 repository README, "Typical x402 flow", naming the headers:
  https://raw.githubusercontent.com/coinbase/x402/main/README.md
- x402 documentation, "Welcome to x402", on the HTTP 402 status code:
  https://docs.x402.org/
