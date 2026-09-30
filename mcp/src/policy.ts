import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

// The owner's policy file is read fresh on every tool call: no cache, no
// watcher. Its exact bytes are also hashed once at server start (see
// pinPolicyFile) and every later read must hash to the same value, so a file
// an agent can write cannot change what the server enforces while it runs.
// This never validates the parsed shape beyond "is it JSON" - consult() is
// the only place that decides whether a policy is well-formed.
export type PolicyFailureCode =
  | "ADAPTER_POLICY_UNREADABLE"
  | "ADAPTER_POLICY_CHANGED";

export type PolicyReadResult =
  | { ok: true; policy: unknown }
  | { ok: false; code: PolicyFailureCode; reason: string };

// The sha256 of the policy file's bytes at server start, or null when the
// file could not be read then. A null pin never matches: a file that appears
// later is not accepted until the owner restarts the server.
export interface PolicyPin {
  readonly sha256: string | null;
}

// A path can name a FIFO, a character device, or a directory instead of a
// file, and any of those can turn a read into a hang or an unbounded copy
// (a FIFO blocks until a writer connects, a device like /dev/zero never
// ends). Stat is metadata only and never opens what it describes, so this
// check rules those out before readFileSync would touch any of them.
const MAX_POLICY_BYTES = 256 * 1024;
const UNREADABLE = "policy file is missing or unreadable";
const CHANGED =
  "policy file changed since the server started; restart the server to accept it";
const UNREADABLE_AT_START =
  "policy file was not readable when the server started; restart the server once it is";

function unreadable(reason: string): PolicyReadResult {
  return { ok: false, code: "ADAPTER_POLICY_UNREADABLE", reason };
}

type BytesResult = { ok: true; raw: Buffer } | { ok: false };

function readPolicyBytes(path: string): BytesResult {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return { ok: false };
  }
  if (!stats.isFile() || stats.size > MAX_POLICY_BYTES) {
    return { ok: false };
  }
  try {
    return { ok: true, raw: readFileSync(path) };
  } catch {
    return { ok: false };
  }
}

function sha256(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Read once, when the server starts. The hash covers the bytes exactly as
// they sit on disk, so a whitespace edit or a swapped symlink target counts.
export function pinPolicyFile(path: string): PolicyPin {
  const bytes = readPolicyBytes(path);
  return { sha256: bytes.ok ? sha256(bytes.raw) : null };
}

function parsePolicy(raw: Buffer): PolicyReadResult {
  try {
    return { ok: true, policy: JSON.parse(raw.toString("utf8")) };
  } catch {
    return unreadable("policy file is not valid JSON");
  }
}

// With a pin, the bytes that are hashed are the same bytes that are parsed,
// from one read, so the file cannot change between the check and the use.
export function readPolicyFile(
  path: string,
  pin?: PolicyPin
): PolicyReadResult {
  if (pin?.sha256 === null) {
    return unreadable(UNREADABLE_AT_START);
  }
  const bytes = readPolicyBytes(path);
  if (!bytes.ok) {
    return unreadable(UNREADABLE);
  }
  if (pin && sha256(bytes.raw) !== pin.sha256) {
    return { ok: false, code: "ADAPTER_POLICY_CHANGED", reason: CHANGED };
  }
  return parsePolicy(bytes.raw);
}
