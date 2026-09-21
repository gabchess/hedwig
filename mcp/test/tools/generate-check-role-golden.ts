// DEV-ONLY. Not run by `mcp:test` or CI. Generates the golden fixture for
// the check_role wire test: it builds the same transaction two ways, once
// with this reader's own pure wire.ts, once with @solana/web3.js (already
// present in the workspace root through the sdk's dependencies), asserts
// the two are byte-for-byte identical, and prints the fixture JSON.
//
// Run once, by hand, from the repository root:
//   npx ts-node mcp/test/tools/generate-check-role-golden.ts
// then paste its output into
// mcp/test/fixtures/solana-role/check-role-golden.json. wire.test.ts reads
// that committed fixture and imports no Solana library itself.
/* eslint-disable */
import { createHash } from "node:crypto";
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  Transaction,
} from "@solana/web3.js";
import { buildCheckRoleTransaction } from "../../src/readers/wire";

// The program id is the repository's own deployed id (programs/hedwig_sol's
// declare_id!, also in Anchor.toml). role/holder/member/feePayer are
// synthetic keypairs generated fresh below: this golden vector proves the
// wire format, not any real on-chain account, so it never needs one.
const PROGRAM_ID = "H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC";
const ROLE = Keypair.generate().publicKey.toBase58();
const HOLDER = Keypair.generate().publicKey.toBase58();
const MEMBER = Keypair.generate().publicKey.toBase58();
const FEE_PAYER = Keypair.generate().publicKey.toBase58();

function main(): void {
  const programId = new PublicKey(PROGRAM_ID);
  const role = new PublicKey(ROLE);
  const holder = new PublicKey(HOLDER);
  const member = new PublicKey(MEMBER);
  const feePayer = new PublicKey(FEE_PAYER);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: member, isSigner: false, isWritable: false },
      { pubkey: role, isSigner: false, isWritable: false },
      { pubkey: holder, isSigner: false, isWritable: false },
    ],
    data: createHash("sha256")
      .update("global:check_role")
      .digest()
      .subarray(0, 8),
  });

  const tx = new Transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = "1".repeat(32); // 32 zero bytes, base58
  tx.add(instruction);
  const web3Bytes = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  const ownBytes = buildCheckRoleTransaction({
    feePayer: FEE_PAYER,
    member: MEMBER,
    role: ROLE,
    holder: HOLDER,
    programId: PROGRAM_ID,
  });

  if (!ownBytes || !web3Bytes.equals(ownBytes)) {
    console.error("MISMATCH");
    console.error("web3.js :", web3Bytes.toString("base64"));
    console.error("wire.ts :", ownBytes?.toString("base64"));
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        programId: PROGRAM_ID,
        role: ROLE,
        holder: HOLDER,
        member: MEMBER,
        feePayer: FEE_PAYER,
        base64: ownBytes.toString("base64"),
      },
      null,
      2
    )
  );
}

main();
