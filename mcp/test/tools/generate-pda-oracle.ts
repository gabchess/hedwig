// DEV-ONLY. Not run by `mcp:test` or CI. Generates the oracle fixture for
// pda.ts: PDA vectors and on-curve vectors, both produced by
// @solana/web3.js (already present in the workspace root through the
// sdk's dependencies) so pda.test.ts can check this reader's pure-BigInt
// reimplementation against the reference library on thousands of cases
// while importing no Solana library itself.
//
// Run once, by hand, from the repository root:
//   npx ts-node mcp/test/tools/generate-pda-oracle.ts
/* eslint-disable */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey(
  "H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC"
);
const VECTOR_COUNT = 2000;

function main(): void {
  const pda: Array<{
    role: string;
    holder: string;
    address: string;
    bump: number;
  }> = [];
  for (let i = 0; i < VECTOR_COUNT; i++) {
    const role = Keypair.generate().publicKey;
    const holder = Keypair.generate().publicKey;
    const [address, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("member"), role.toBuffer(), holder.toBuffer()],
      PROGRAM_ID
    );
    pda.push({
      role: role.toBase58(),
      holder: holder.toBase58(),
      address: address.toBase58(),
      bump,
    });
  }

  const onCurve: Array<{ bytes: string; onCurve: boolean }> = [];
  for (let i = 0; i < VECTOR_COUNT; i++) {
    const bytes = Keypair.generate().publicKey.toBuffer();
    // Half the time, mutate the bytes so this set isn't skewed toward
    // "freshly generated keypair, therefore always on-curve": a random
    // buffer is on-curve about half the time either way, but this keeps
    // the source visibly mixed.
    if (i % 2 === 0) {
      bytes[0] ^= 0xff;
    }
    onCurve.push({
      bytes: bytes.toString("base64"),
      onCurve: PublicKey.isOnCurve(bytes),
    });
  }

  const onCurveCount = onCurve.filter((v) => v.onCurve).length;
  console.error(
    `generated ${pda.length} PDA vectors and ${
      onCurve.length
    } on-curve vectors (${onCurveCount} on-curve, ${
      onCurve.length - onCurveCount
    } off-curve)`
  );

  const outPath = join(
    __dirname,
    "..",
    "fixtures",
    "solana-role",
    "pda-oracle.json"
  );
  writeFileSync(
    outPath,
    JSON.stringify({ programId: PROGRAM_ID.toBase58(), pda, onCurve })
  );
  console.error(`wrote ${outPath}`);
}

main();
