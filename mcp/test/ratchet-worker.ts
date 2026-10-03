import { createRatchet } from "../src/readers/registry-asset";

// Child process for the concurrent ratchet test: waits for a shared start
// time, then admits `count` distinct keys with sequence 5 on one file.
const [file, prefix, count, startAt] = process.argv.slice(2);
const ratchet = createRatchet(file);
while (Date.now() < Number(startAt)) {
  // Spin so every worker starts writing in the same instant.
}
for (let i = 0; i < Number(count); i += 1) {
  ratchet.admit(`token:${prefix}:${i}`, 5);
}
