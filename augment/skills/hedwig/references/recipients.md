# Recipients

A recipient is an address the owner named in advance. Hedwig compares the
address in the request against a list the owner wrote before the request
existed, and against a fixed registry of addresses recorded as first seen
through a poison transfer. An address the agent found somewhere else
carries no standing here: not one copied out of a transaction history,
not one read off a block explorer page, not one lifted from the free text
of the task the agent was given. Trezor's own support page gives a person
the same practice, which is to check the address rather than copy one
back out of history.

## What Hedwig reads

Three Floor Conditions read the recipient.

- `recipient-matches-policy` asks "Does the recipient match an entry the
  owner approved?" It reads `request.action.recipient`,
  `request.action.chainId`, and `policy.approvedRecipients`, the
  allowlist the owner sets in advance.
- `recipient-not-poison-derived` asks "Is the recipient free of any
  recorded poison transfer?" It reads the same two request fields and the
  catalog's own fixed registry of poison-derived addresses. It reads no
  policy field at all.
- `output-recipient-is-owner` asks "Does the output land on an address
  the owner holds, free of any recorded poison transfer?" It is swap's
  single recipient row: it reads `request.action.recipient`,
  `request.action.chainId`, and `policy.ownerAddresses`, and it applies
  the poison registry itself, since swap's Floor names no separate poison
  row.

Address poisoning is the scam the second and third rows describe. The
attacker generates a vanity address whose characters are chosen to look
like the address the victim means to use, then sends that address a
transfer the victim's history keeps: a zero-value transfer, or a
worthless token that imitates the amount and symbol of a real payment
sitting next to it in the list. On Ethereum and EVM chains anyone may
send any token to any address, and a block explorer lists addresses in
bulk, so seeding a history is cheap and scales. The loss lands when
someone copies the lookalike out of their own history. Trezor's
advice is to skip transaction history as a source of addresses, a
person's own address included, and to read every character before
confirming.

An EVM address is its 20 raw bytes. The case of its hex digits carries
the optional ERC-55 encoding and nothing else. ERC-55 forms that encoding
by hashing the lowercase hex address, treated as ASCII, with keccak256,
then printing each letter digit in uppercase when the matching nibble of
the hash is 8 or higher. A mixed-case address that fails that test is a
spelling no address produces, which points at a mistyped or substituted
digit. An address written in one case throughout carries no checksum, so
it reports nothing either way. Hedwig folds case once both sides pass the
shape check, so two spellings of one address are one recipient, while a
lookalike differs in its actual hex digits and still fails.

Hedwig reads addresses, never names. `recipient` has to match the shape
`0x` plus 40 hex digits, so a caller that starts from an ENS name
resolves it first and passes the address the resolver returned. ENS
resolution is a live lookup: the registry names the resolver for a name,
and that resolver answers `addr()` with whatever it holds at the moment
it is asked. The address in the request is therefore the address the
owner's list is compared against, and the name is out of the loop by the
time `consult()` runs. ENS documents the same care in the other
direction: follow a reverse lookup with a forward lookup, and show the
address instead of the name when the two disagree.

## What PASS, FAIL and UNVERIFIED mean here

`recipient-matches-policy`:

- PASS: the recipient is a well-formed EVM address matching an entry in
  `policy.approvedRecipients`, compared with hex case folded.
- FAIL: the recipient is well-formed and matches no approved entry.
- UNVERIFIED: the chain family is not `eip155`, the recipient is missing
  or not a well-formed EVM address, or `approvedRecipients` is not a list
  of non-empty strings.

`recipient-not-poison-derived`:

- PASS: the recipient is well-formed and has no recorded poison transfer.
- FAIL: the recipient matches a registry entry recorded as first seen
  through a poison transfer.
- UNVERIFIED: the chain family is not `eip155`, or the recipient is not a
  well-formed EVM address, so the registry cannot be consulted at all.

`output-recipient-is-owner`:

- PASS: the recipient is well-formed, carries no recorded poison
  transfer, and matches an entry in `policy.ownerAddresses`.
- FAIL: the recipient was first seen through a poison transfer, or it is
  well-formed and matches no owner address.
- UNVERIFIED: the chain family is not `eip155`, the recipient is not a
  well-formed EVM address, or `ownerAddresses` is missing, empty, or not
  a list of non-empty strings.

All three are Floor Conditions. One FAIL among them makes the verdict
`DENY`, and one UNVERIFIED makes it `UNKNOWN`, so neither answer reaches
`proceed: true`.

## Sources

- ERC-55: Mixed-case checksum address encoding:
  https://eips.ethereum.org/EIPS/eip-55
- Trezor support, "What are address poisoning attacks and how to avoid
  them": https://trezor.io/support/a/address-poisoning-attacks
- ENS documentation, "Resolution": https://docs.ens.domains/resolution
