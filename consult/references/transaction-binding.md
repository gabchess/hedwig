# transaction-matches-intent

Every pay and swap request must supply an unsigned call proposal with exactly
four string fields: `from`, `to`, `data`, and `value`. The action supplies the
EVM chain ID. Missing, malformed or unsupported calls are UNVERIFIED. Supported
calls that contradict the action are FAIL. This condition is mandatory even
when `conditions` is empty.

The supported payment is ERC-20 `transfer(address,uint256)` with zero native
value and exactly two canonical ABI words. Its target, recipient and amount
must match the action. Direct transfer cannot satisfy a policy requiring an
EIP-3009 authorization window. Approvals, permits and authorizations require
their own decoders and remain unsupported.

The native Monad swap profile remains the fixed Router02 multicall containing
`exactInputSingle` followed by `refundETH`. Matching its bytes does not enable
execution. Existing router, native-token and evidence checks still apply.
Other swap profiles, including Universal Router, remain unsupported.

A successful binding adds `callDigest` to the consult response. Its value is
`sha256:` followed by the SHA-256 hex digest of the UTF-8 JSON array
`["hedwig:evm-call:v1", chainId, from, to, value, data]`. Addresses and calldata
use lowercase hex; value uses canonical decimal. The digest covers those call
fields only. Nonce, gas, fees, replay protection and transaction execution are
outside its scope. A binding can coexist with DENY or UNKNOWN from other checks.

The guard verifies the digest before calling its signer, then supplies the
frozen action, chain ID, transaction and digest. Consumers must use the captured
proposal and verify the active signer account and chain. Hedwig remains
advisory; third-party signers can bypass it.
