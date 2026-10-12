# Hedwig threat model

This document sets the security boundary of the payment check, the MCP server and the install path.

Hedwig has not had an external security review.

## The payment check's boundary

`consult()` reads three inputs: the request the caller maps, the owner's
policy file, and the facts the caller supplies as data. It makes no network
call, reads no clock, holds no key, and signs nothing.

The caller controls the proposed call and the facts. Supported EVM calls must
match their declared intent byte for byte under the supported decoder.
Independent evidence is still needed for the facts. Hedwig cannot verify what
a separate signer eventually submits.

The owner controls the policy file: the approved recipients, the caps, the
named chain, the role choice and the authorization window. The MCP server
reads that file from the path in `HEDWIG_POLICY_FILE`, and reads a required
Solana role through the RPC endpoint named in the environment.

The server hashes the policy file's bytes when it starts and compares every
later read to that hash. Within one server run, a caller that can write the
file cannot add its own recipient and get the next request approved: any change
to the file's bytes, by an edit, a replacement or a symlink swap, answers
`UNKNOWN` with `ADAPTER_POLICY_CHANGED`. A deleted file, a file larger than
256 KB (262,144 bytes), or a directory or FIFO in the file's place answers
`UNKNOWN` with `ADAPTER_POLICY_UNREADABLE`. So does every call in a run that
started while the file could not be read. On `ADAPTER_POLICY_CHANGED` the reply
says only that the file changed; the restart advice goes to stderr, for the
Owner.

The pin lasts as long as the server process. Every server start, which means
every client session and every reconnect, hashes whatever the file holds at
that moment and accepts it with no warning. A caller that can write the file
can also make the server exit, for example with a message over 256 KB, and
the next start pins the caller's version. To stay safe across restarts, the
Owner reviews the file before restarting the server, or keeps it where the
agent's OS user cannot write it. The pin does not stop a caller that can
change the file before the server starts, or that can change the server's
environment or binary.

The hash covers bytes, not meaning. Replacing the file with identical bytes
or changing its permissions in a way that keeps it readable does not change
the answer. A permissions change that makes the file unreadable answers
`UNKNOWN` with `ADAPTER_POLICY_UNREADABLE`. Only the pinned bytes can ever be
approved.

Hedwig returns `proceed`, a verdict, and one row per Condition. Acting on
that answer is the caller's own step.

The current catalog accepts `pay` and `swap` requests. Its supported EVM
call formats are direct ERC-20 `transfer(address,uint256)` and the narrow
native Monad Router02 profile. Missing bytes, undecoded routes and
EIP-3009 authorization requirements on a direct transfer cannot earn
`proceed: true`. Matching native Monad bytes still require the existing
live-evidence checks and do not enable execution.

Slippage checks compare the supplied quote and minimum output with policy.
The `support` number is calculated after the verdict and cannot authorize a
payment.

The registry reader in `main` verifies signed rows and chain observations,
but its pinned public keys are currently empty. It therefore accepts no rows.
The core trusts an integration to verify any registry facts it supplies.
Vault facts have no consuming check yet, and `deposit` is not a supported
action.

Unknown pay assets have market-data checks that need fresh readings from the
owner's RPC and the service's parameters. The public MCP server does not
collect those readings or supply the parameters. Missing evidence stays
UNVERIFIED; a market check cannot establish a token's identity.

### The Trigger guard

A caller can hand that step to the Trigger guard, `runTriggerGuard` in
`@hedwig/consult/guard`. The caller passes its payment, a function that maps
the payment to a request, the policy, an optional `gather` function for facts,
and its own signer. The guard holds no key. It signs only through the signer
the caller injects.

The guard maps the request once. Right after the mapping returns, and before
`gather` runs, it turns the request into its own JSON snapshot. `gather`,
`consult()` and the signer all receive that same data, and the guard never
reads the caller's object again.

The verdict comes from `consult()`; the guard's input has no field for one.
The guard calls the signer at most once. It requires
`ALLOW_UNDER_POLICY`, `proceed: true` and a matching recomputed call digest.
It passes a frozen object containing `action`, `chainId`, `transaction`
and `callDigest`. The signer must check its active chain and account, then use
the supplied call fields. A signer that ignores that object remains outside
the guard's enforcement.

The digest binds chain, sender, target, native value and calldata. It is an
unkeyed content hash. It does not authenticate a remote response, bind nonce
or gas fees, prevent replay, enforce cumulative spending, or prove that funds
will be safe. Remote integrations must authenticate Hedwig independently.

## Agent installation boundary

The owner confirms the repository and release directly through GitHub before
approving local execution. The install recipe checks the fetched revision and
disables dependency lifecycle scripts with `--ignore-scripts`. Explicit build
commands and the server still execute approved code and dependencies.

A website and a checksum served by that same website share a compromise
boundary. The independent GitHub check reduces that dependency; it does not
prove a signed release or protect a compromised GitHub account. Release
signing, maintainer account security and hosting controls need separate
verification. Existing release pins are retained until a new release passes
the install checks.

## Solana role read

`check_role` proves a statement about a pubkey. It does not prove that the caller controls that pubkey.

The role fact comes from the owner's own RPC endpoint. Hedwig reads it. It does not vouch for it.

## Reporting vulnerabilities

Do not open a public issue for an undisclosed vulnerability. Follow
[`SECURITY.md`](SECURITY.md) to use GitHub's private advisory flow or request a
private maintainer channel. There is no bug bounty program at this stage.
