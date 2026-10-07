# core input checks

Before any Condition runs, the request and policy shape, the action type,
and the presence of a mandatory Floor are checked on their own. An
oversized, malformed, or unrecognised request stops here, before any
Condition's checker runs, and a caller-supplied condition id runs only code
the catalog declares.

- An unrecognised action type, a missing mandatory Floor, an oversized or
  malformed request or policy, an unknown condition id, a checker that
  throws, and a checker that returns a malformed result all resolve to
  UNVERIFIED and name the specific defect. None of these can resolve to
  PASS.

Pay and swap include the mandatory [call binding](transaction-binding.md)
condition. An action-only request cannot proceed. A supported bound call adds
the optional `callDigest` response field, including when another condition
denies or cannot verify the action. Strict response-key and floor validators
must accept this field and `transaction-matches-intent` before consuming the
new response. Existing diagnostic conditions remain present.

The guard's signer callback receives `{ action, chainId, transaction,
callDigest }`. The transaction includes the proposed sender account in `from`.
Callback consumers must verify that account and chain against their signer and
use the captured call bytes. The receipt covers call fields only and grants no
control over an external signer.
