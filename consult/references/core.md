# core input checks

Before any Condition runs, the request and policy shape, the action type,
and the presence of a mandatory Floor are checked on their own. This
prevents an oversized, malformed, or unrecognised request from ever reaching
a Condition's checker, and prevents a caller-supplied condition id from
running code the catalog never declared.

- An unrecognised action type, a missing mandatory Floor, an oversized or
  malformed request or policy, an unknown condition id, a checker that
  throws, and a checker that returns a malformed result all resolve to
  UNVERIFIED and name the specific defect. None of these can resolve to
  PASS.
