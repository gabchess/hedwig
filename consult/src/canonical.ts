// The canonical-address lookup on its own door, for a caller that needs the
// same answer the token Conditions use (the code table first, then a
// registry Fact in facts) without running consult(). It carries no checker
// and no verdict: a caller reaches it only through the
// `@hedwig/consult/canonical` subpath, and index.ts never re-exports it.
export { canonicalAddressFor } from "./catalog";
export type { CanonicalAddress } from "./catalog";
