# output-recipient-is-owner

The address receiving the swap's output is checked against the owner's own
list of addresses and against the recorded poison-transfer registry. The
check flags a swap that quietly redirects its proceeds to an address the
owner never held, including one first seen through a poison transfer
designed to get copied into a future recipient field.

- PASS: the recipient is a well-formed address matching an entry in the
  owner's list, and carries no recorded poison transfer.
- FAIL: the recipient is well-formed but matches no entry in the owner's
  list, or the recipient was first seen through a poison transfer.
- UNVERIFIED: the recipient is missing or not a well-formed address, the
  chain family is not supported, or the owner's address list is missing or
  malformed.

## Sources

- MetaMask Support, "Address poisoning scams": https://support.metamask.io/privacy-and-security/staying-safe-in-web3/address-poisoning-scams/
