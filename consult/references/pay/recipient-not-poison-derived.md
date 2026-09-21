# recipient-not-poison-derived

The recipient is checked against a fixed registry of addresses first seen
through an address-poisoning transfer: a scam that seeds a wallet's
transaction history with a lookalike address so a later copy-paste sends
funds to the attacker instead of the intended party. This prevents an agent
from reusing an address it saw in history without knowing the history itself
was poisoned.

- PASS: the recipient has no recorded poison-transfer origin.
- FAIL: the recipient was first seen through a poison transfer.
- UNVERIFIED: the recipient is not a well-formed address for its chain
  family, so the registry cannot be checked at all.

## Sources

- MetaMask Support, "Address poisoning scams": https://support.metamask.io/privacy-and-security/staying-safe-in-web3/address-poisoning-scams/
