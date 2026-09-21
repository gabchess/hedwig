# deadline-set-and-fresh

The transaction deadline is compared against the current time, supplied to
consult() as data rather than read from a clock inside it. The check
flags a swap with no real deadline, one already in the past, and one set
so far out that it stays executable long after the quote it was built
from goes stale.

- PASS: the deadline is an integer JavaScript can represent exactly,
  strictly after the current time, and no more than the owner's
  configured window past it.
- FAIL: the deadline is at or before the current time, or more than the
  owner's window past it.
- UNVERIFIED: the deadline is not an integer JavaScript can represent
  exactly, the current time was not supplied, or the owner has not
  configured a window.

## Sources

- Uniswap Universal Router repository, whose `execute` entry point takes
  a transaction deadline: https://github.com/Uniswap/universal-router
