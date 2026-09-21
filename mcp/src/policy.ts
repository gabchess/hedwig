import { readFileSync, statSync } from "node:fs";

// The owner's policy file is read fresh on every tool call: no cache, no
// watcher. This never validates the parsed shape beyond "is it JSON" -
// consult() is the only place that decides whether a policy is well-formed.
export type PolicyReadResult =
  | { ok: true; policy: unknown }
  | { ok: false; reason: string };

// A path can name a FIFO, a character device, or a directory instead of a
// file, and any of those can turn a read into a hang or an unbounded copy
// (a FIFO blocks until a writer connects, a device like /dev/zero never
// ends). Stat is metadata only and never opens what it describes, so this
// check rules those out before readFileSync would touch any of them.
const MAX_POLICY_BYTES = 256 * 1024;
const UNREADABLE = "policy file is missing or unreadable";

export function readPolicyFile(path: string): PolicyReadResult {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return { ok: false, reason: UNREADABLE };
  }
  if (!stats.isFile()) {
    return { ok: false, reason: UNREADABLE };
  }
  if (stats.size > MAX_POLICY_BYTES) {
    return { ok: false, reason: UNREADABLE };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: UNREADABLE };
  }
  try {
    return { ok: true, policy: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: "policy file is not valid JSON" };
  }
}
