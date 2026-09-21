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
