import { setImmediate } from "node:timers/promises";

import { createRatchet } from "../src/readers/registry-asset";

// Child process for the concurrent ratchet test: waits for a shared start
// time, then admits `count` distinct keys with sequence 5 on one file.
const [file, prefix, count, startAt, retryMs = "5000"] = process.argv.slice(2);
const ratchet = createRatchet(file);

async function run(): Promise<void> {
  while (Date.now() < Number(startAt)) {
    // Spin so every worker starts writing in the same instant.
  }
  const deadline = performance.now() + Number(retryMs);
  for (let i = 0; i < Number(count); i += 1) {
    const key = `token:${prefix}:${i}`;
    // A read can see another process's incomplete append. A rejection must
    // retry this key, rather than silently skipping an intended test write.
    while (!ratchet.admit(key, 5)) {
      if (performance.now() >= deadline) {
        throw new Error(`timed out admitting ${key}`);
      }
      await setImmediate();
    }
  }
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
