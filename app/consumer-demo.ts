/**
 * Devnet proof that an authenticated Hedwig member can change state in a
 * separate consumer program through CPI.
 *
 * Usage: see app/README.md
 */
import { createHash } from "crypto";
import { AnchorProvider, Wallet } from "@anchor-lang/core";
import {
  HEDWIG_PROGRAM_ID,
  createHedwigProgram,
  deriveMemberPda,
  deriveOrgPda,
  deriveRolePda,
  sendAssignRole,
  sendCreateOrg,
  sendCreateRole,
} from "@hedwig-sol/sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  CONSUMER_DEMO_KEYPAIR_PATH,
  assertDevnetGenesisHash,
  assertPayerCanCover,
  loadOrGenerateKeypair,
  requiredPayerLamports,
  resolveKeypairPath,
} from "./revoke-demo-lib";

const CONSUMER_PROGRAM_ID = new PublicKey(
  "52D3pTYvMwLYbiigY5xg55n4HmtEzTKCEicx1Cojzo9a"
);
const ACTOR_FUNDING_LAMPORTS = 20_000_000;

function discriminator(namespace: "account" | "global", name: string): Buffer {
  return createHash("sha256")
    .update(`${namespace}:${name}`)
    .digest()
    .subarray(0, 8);
}

async function sendActorInstruction(
  connection: Connection,
  actor: Keypair,
  instruction: TransactionInstruction
): Promise<string> {
  return sendAndConfirmTransaction(
    connection,
    new Transaction().add(instruction),
    [actor],
    { commitment: "confirmed" }
  );
}

async function main() {
  const rpcUrl = process.env.HELIUS_RPC_URL || clusterApiUrl("devnet");
  const connection = new Connection(rpcUrl, "confirmed");

  // Before any key is read or any transaction is signed: an RPC URL can
  // name any cluster, so the cluster's own answer decides.
  assertDevnetGenesisHash(await connection.getGenesisHash());

  const keypair = resolveKeypairPath(process.env, CONSUMER_DEMO_KEYPAIR_PATH);
  console.log(`[setup] keypair: ${keypair.path} (${keypair.source})`);
  const payer = loadOrGenerateKeypair(keypair.path);
  const payerLamports = await connection.getBalance(payer.publicKey);
  // The payer sends the funding transfer: the spend, one signature's fee,
  // and a rent-exempt zero-data account left behind.
  assertPayerCanCover(
    payer.publicKey.toBase58(),
    payerLamports,
    requiredPayerLamports({
      spendLamports: ACTOR_FUNDING_LAMPORTS,
      signatures: 1,
      rentExemptMinimumLamports:
        await connection.getMinimumBalanceForRentExemption(0),
    })
  );
  const actor = Keypair.generate();

  const consumerAccount = await connection.getAccountInfo(CONSUMER_PROGRAM_ID);
  if (!consumerAccount?.executable) {
    throw new Error(
      `Consumer program ${CONSUMER_PROGRAM_ID.toBase58()} is not executable on devnet.`
    );
  }

  const fundingSignature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: actor.publicKey,
        lamports: ACTOR_FUNDING_LAMPORTS,
      })
    ),
    [payer],
    { commitment: "confirmed" }
  );
  console.log(
    `[fund_actor] actor=${actor.publicKey.toBase58()} tx=${fundingSignature}`
  );

  const provider = new AnchorProvider(connection, new Wallet(actor), {
    commitment: "confirmed",
  });
  const hedwigProgram = createHedwigProgram(provider);
  const orgName = `consumer-${Math.random().toString(36).slice(2, 10)}`;
  const roleName = "operator";
  const [org] = deriveOrgPda(actor.publicKey);
  const [role] = deriveRolePda(org, roleName);
  const [member] = deriveMemberPda(role, actor.publicKey);
  const [counter] = PublicKey.findProgramAddressSync(
    [Buffer.from("counter"), actor.publicKey.toBuffer()],
    CONSUMER_PROGRAM_ID
  );

  const createOrgSignature = await sendCreateOrg(
    provider,
    { authority: actor.publicKey, name: orgName },
    { signers: [] }
  );
  console.log(`[create_org] org=${org.toBase58()} tx=${createOrgSignature}`);

  const createRoleSignature = await sendCreateRole(
    provider,
    {
      org,
      authority: actor.publicKey,
      name: roleName,
    },
    { signers: [] }
  );
  console.log(
    `[create_role] role=${role.toBase58()} tx=${createRoleSignature}`
  );

  const assignRoleSignature = await sendAssignRole(
    provider,
    {
      role,
      holder: actor.publicKey,
      admin: actor.publicKey,
      expiresAt: null,
    },
    { signers: [] }
  );
  console.log(
    `[assign_role] member=${member.toBase58()} tx=${assignRoleSignature}`
  );

  const initializeSignature = await sendActorInstruction(
    connection,
    actor,
    new TransactionInstruction({
      programId: CONSUMER_PROGRAM_ID,
      keys: [
        { pubkey: counter, isSigner: false, isWritable: true },
        { pubkey: actor.publicKey, isSigner: true, isWritable: true },
        { pubkey: role, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: discriminator("global", "initialize_counter"),
    })
  );
  console.log(
    `[initialize_counter] counter=${counter.toBase58()} tx=${initializeSignature}`
  );

  const incrementSignature = await sendActorInstruction(
    connection,
    actor,
    new TransactionInstruction({
      programId: CONSUMER_PROGRAM_ID,
      keys: [
        { pubkey: counter, isSigner: false, isWritable: true },
        { pubkey: actor.publicKey, isSigner: true, isWritable: false },
        { pubkey: member, isSigner: false, isWritable: false },
        { pubkey: role, isSigner: false, isWritable: false },
        { pubkey: HEDWIG_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: discriminator("global", "increment_counter"),
    })
  );
  console.log(`[increment_counter] value=1 tx=${incrementSignature}`);

  const counterAccount = await connection.getAccountInfo(counter, "confirmed");
  if (!counterAccount || !counterAccount.owner.equals(CONSUMER_PROGRAM_ID)) {
    throw new Error("Consumer counter is missing or has the wrong owner.");
  }
  if (
    !counterAccount.data
      .subarray(0, 8)
      .equals(discriminator("account", "Counter"))
  ) {
    throw new Error("Consumer counter discriminator does not match Counter.");
  }

  const storedAuthority = new PublicKey(counterAccount.data.subarray(8, 40));
  const storedRole = new PublicKey(counterAccount.data.subarray(40, 72));
  const value = counterAccount.data.readBigUInt64LE(72);
  if (
    !storedAuthority.equals(actor.publicKey) ||
    !storedRole.equals(role) ||
    value !== 1n
  ) {
    throw new Error(
      "Consumer counter state does not match the authorized actor."
    );
  }

  const memberAccount = await hedwigProgram.account.member.fetch(member);
  if (!memberAccount.holder.equals(actor.publicKey)) {
    throw new Error("Hedwig member holder does not match the consumer actor.");
  }

  console.log(
    `[state] authority=${storedAuthority.toBase58()} role=${storedRole.toBase58()} value=${value}`
  );
  console.log("Hedwig-gated consumer state change OK on devnet");
}

main().catch((error) => {
  console.error("[error] consumer demo failed:");
  console.error(error);
  process.exit(1);
});
