import { createHash } from "node:crypto";

// Update only with a reviewed source-pack change. Keep the expected value in
// compiled code, independently of the JSON asset whose integrity it checks.
// This detects mismatched assets, not an attacker who can replace both files.
export const BUILTIN_FOUNDATION_PACK_SHA256 =
  "d61ab07018c7d84eebd0f014c58bd2f6c2b005661cb27054c6b1a0957b9bc40a";

// Sort object keys but preserve array order and JSON scalar values. Whitespace,
// line endings and bundler object formatting do not change this representation.
function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("foundation built-in pack contains a non-JSON value");
}

/** Check the published built-in asset, separately from generic pack validation. */
export function assertBuiltinFoundationPack(pack: unknown): void {
  const digest = createHash("sha256").update(canonicalJson(pack)).digest("hex");
  if (digest !== BUILTIN_FOUNDATION_PACK_SHA256) {
    throw new Error("foundation built-in pack integrity mismatch");
  }
}
