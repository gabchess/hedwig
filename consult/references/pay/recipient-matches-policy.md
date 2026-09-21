# recipient-matches-policy

The recipient of a payment is checked against an explicit allowlist the owner
sets in advance, rather than checked for the absence of anything bad. The
check flags an address the owner never approved, including a
plausible-looking address the agent picked on its own.

- PASS: the recipient exactly matches an entry in the owner's approved list.
- FAIL: the recipient is well-formed but does not match any approved entry.
- UNVERIFIED: the recipient or the approved list is not in a shape that can
  be compared at all.

## Sources

- OWASP Input Validation Cheat Sheet, "Allowlist vs. Denylist Input
  Validation": https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
