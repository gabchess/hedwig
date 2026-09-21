import { readFileSync } from "node:fs";

// The owner's policy file is read fresh on every tool call: no cache, no
// watcher. This never validates the parsed shape beyond "is it JSON" -
// consult() is the only place that decides whether a policy is well-formed.
export type PolicyReadResult =
  | { ok: true; policy: unknown }
  | { ok: false; reason: string };

export function readPolicyFile(path: string): PolicyReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "policy file is missing or unreadable" };
  }
  try {
    return { ok: true, policy: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: "policy file is not valid JSON" };
  }
}
