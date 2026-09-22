# authorization-window-within-ceiling

Every policy states the owner's choice about an EIP-3009 authorization's
validity window: required, or not required, the same shape `role` uses.
When required, the check compares the authorization's `validBefore` against
the current time, supplied to `consult()` as data rather than read from a
clock inside it. `consult()` makes no network call. The check flags an
authorization with no usable `validBefore`, one already past, and one set
so far out that it stays valid long after the owner's maximum window.

When the owner's policy sets `authorizationWindow.mode` to `"not-required"`,
this row passes without reading the request. A `mode: "required"` policy
names `maxSeconds`, the longest a fresh authorization's window may run, an
integer from 1 to 86400.

- PASS: `authorizationWindow.mode` is `"not-required"`, or it is
  `"required"` with a well-formed `maxSeconds`, a `validBefore` that is a
  safe positive integer, strictly after the current time, and no more than
  `maxSeconds` past it.
- FAIL: the policy is `"required"` and well-formed, `validBefore` is a
  well-formed integer, and it is at or before the current time, or more
  than `maxSeconds` past it.
- UNVERIFIED: `authorizationWindow` is absent or not an object
  (`AUTHORIZATION_POLICY_MISSING`); it is an object whose `mode` is neither
  `"required"` nor `"not-required"` (`AUTHORIZATION_POLICY_MALFORMED`);
  `mode` is `"required"` and `maxSeconds` is absent
  (`AUTHORIZATION_CEILING_MISSING`) or present but not an integer from 1 to
  86400 (`AUTHORIZATION_CEILING_MALFORMED`); `validBefore` is not a safe
  positive integer (`AUTHORIZATION_MALFORMED`); or the current time was not
  supplied (`AUTHORIZATION_NOW_UNAVAILABLE`). The clock is a fact the
  caller supplies, the same way `facts.now` is for `deadline-set-and-fresh`;
  without it, the authorization's age can never be judged.

## Sources

- EIP-3009, `transferWithAuthorization`'s `validBefore` parameter, "the
  time before which this is valid (unix time)":
  https://eips.ethereum.org/EIPS/eip-3009
- The x402 specification's `maxTimeoutSeconds`, the field a facilitator
  derives an authorization's window from:
  https://github.com/coinbase/x402/blob/main/specs/x402-specification-v1.md
