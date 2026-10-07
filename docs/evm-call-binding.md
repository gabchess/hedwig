# EVM call binding

This describes the changed contract on main after the security patch is
merged. The pinned v0.4.2 installation predates it. Do not mix those versions
or claim the old release has these checks.

## Supported requests

An EVM request includes its declared `action` and an unsigned `transaction`
with exactly `from`, `to`, `data` and `value`. Each value is a string.
Native value uses canonical decimal base units. Calldata uses complete hex
bytes. Addresses are nonzero 20-byte EVM addresses.

- A `pay` can use direct ERC-20 `transfer(address,uint256)`. The target,
  token, decoded recipient and amount must agree with the action; native
  value must be zero. Plain transfer bytes cannot satisfy an EIP-3009
  authorization-window requirement.
- The existing native Monad Router02 profile keeps its narrow decoder and
  all live-evidence restrictions.
- Other swap routes, approvals, permit calls, batches and undecoded calls
  cannot earn `proceed: true`.

A missing or unsupported proposal returns an incomplete check. A decoded
contradiction fails the check. Other policy and evidence checks still apply.
There is no setting that restores an intent-only allow.

## Response and signer migration

A successfully bound proposal can carry `callDigest`, formatted as
`sha256:<64 lowercase hex digits>`. It may accompany a denied result.
Always read `proceed` and the verdict. The digest alone grants no permission.

The digest input is UTF-8 JSON for this ordered array:

```text
["hedwig:evm-call:v1", chainId, lowercase(from), lowercase(to), value, lowercase(data)]
```

The reference guard now passes this object to its signer callback:

```ts
{ action, chainId, transaction, callDigest }
```

An old callback expecting only `action` needs migration. Before invoking a
wallet, the integration must compare its active account with
`transaction.from` and its active chain with `chainId`. It must send the
checked `to`, `data` and `value` unchanged. A changed call requires a fresh
assessment. Keep owner approval and wallet controls in place.

The guard captures the request before asynchronous fact reads, recomputes its
digest before invoking the callback, and never invokes it for a missing or
mismatched binding. A callback can still ignore its input. Hedwig holds no key
and cannot enforce another wallet's behavior.

## Limits and rollout

This is a call-content digest, not a signed authorization. Nonce, gas, fees,
expiry, replay protection and cumulative spend are separate requirements.
Authenticate remote responses before trusting them. Existing Monad matching
bytes remain insufficient for a positive live assessment.

Update strict response parsers to accept the optional digest and the new
mandatory check. Intent-only fixtures must now stop. Test the real consumer
against the same checked-out version before changing a release pin.

Keep the current release available while reviewing this breaking guard
change. If rollout fails, disable the affected integration. Reverting to
intent-only behavior restores the reported gap and is not a safe fallback
for signing.
