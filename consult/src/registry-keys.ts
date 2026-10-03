// The two public keys that sign every registry row, on their own door for
// the Reader that verifies rows: a caller can never supply one, and a key
// change needs a release. Each is a raw 32 byte ed25519 public key as
// canonical base64 (44 characters). Both ship empty until the signing
// sitting names them, and an empty or equal pair rejects every row, so the
// Reader fails closed. The two keys sit in separate slots, a and b, and a
// row needs a valid signature under each. index.ts never re-exports these.
export const REGISTRY_PUBLIC_KEY_A = "";
export const REGISTRY_PUBLIC_KEY_B = "";
