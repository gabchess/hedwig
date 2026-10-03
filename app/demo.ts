/**
 * Devnet end-to-end lifecycle demo for the Hedwig roles primitive.
 *
 * Exercises all six Hedwig instructions through @hedwig-sol/sdk:
 *   create_org -> create_role -> assign_role -> check_role ->
 *   set_role_enabled(false) -> revoke_role
 *
 * Usage: see app/README.md
 */
import { AnchorProvider, Wallet } from "@anchor-lang/core";
import {
  createHedwigProgram,
  deriveMemberPda,
  deriveOrgPda,
  deriveRolePda,
  sendAssignRole,
  sendCheckRole,
  sendCreateOrg,
  sendCreateRole,
  sendRevokeRole,
  sendSetRoleEnabled,
} from "@hedwig-sol/sdk";
import { Connection, Keypair, clusterApiUrl } from "@solana/web3.js";
import {
  LIFECYCLE_ACCOUNT_BYTES,
  LIFECYCLE_DEMO_KEYPAIR_PATH,
  assertDevnetGenesisHash,
  assertPayerCanCover,
  loadOrGenerateKeypair,
  requiredPayerLamports,
  resolveKeypairPath,
} from "./revoke-demo-lib";

function randomOrgName(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `demo-org-${suffix}`;
}

async function main() {
  const rpcUrl = process.env.HELIUS_RPC_URL || clusterApiUrl("devnet");
  const connection = new Connection(rpcUrl, "confirmed");

  // Before any key is read or any transaction is signed: an RPC URL can
  // name any cluster, so the cluster's own answer decides.
  assertDevnetGenesisHash(await connection.getGenesisHash());

  const keypair = resolveKeypairPath(process.env, LIFECYCLE_DEMO_KEYPAIR_PATH);
  console.log(`[setup] keypair: ${keypair.path} (${keypair.source})`);
  const payer = loadOrGenerateKeypair(keypair.path);
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  console.log(`[setup] wallet: ${payer.publicKey.toBase58()}`);
  const balanceLamports = await connection.getBalance(payer.publicKey);
  console.log(`[setup] balance: ${balanceLamports / 1e9} SOL`);

  const program = createHedwigProgram(provider);
  // The run creates an org, a role and a member account (the member's rent
  // returns at revoke_role, but the payer must hold it first) and signs six
  // transactions.
  const rents = await Promise.all(
    LIFECYCLE_ACCOUNT_BYTES.map((bytes) =>
      connection.getMinimumBalanceForRentExemption(bytes)
    )
  );
  assertPayerCanCover(
    payer.publicKey.toBase58(),
    balanceLamports,
    requiredPayerLamports({
      spendLamports: rents.reduce((sum, rent) => sum + rent, 0),
      signatures: 6,
      rentExemptMinimumLamports:
        await connection.getMinimumBalanceForRentExemption(0),
    })
  );

  const orgName = randomOrgName();
  const roleName = "treasurer";
  const holder = Keypair.generate();

  console.log(`[setup] org name: ${orgName}`);
  console.log(`[setup] role name: ${roleName}`);
  console.log(`[setup] holder: ${holder.publicKey.toBase58()}`);

  const [orgPda] = deriveOrgPda(payer.publicKey);
  const [rolePda] = deriveRolePda(orgPda, roleName);
  const [memberPda] = deriveMemberPda(rolePda, holder.publicKey);

  // 1. create_org
  const createOrgSig = await sendCreateOrg(
    provider,
    {
      authority: payer.publicKey,
      name: orgName,
    },
    { signers: [] }
  );
  console.log(`[create_org] org=${orgPda.toBase58()} tx=${createOrgSig}`);

  // 2. create_role
  const createRoleSig = await sendCreateRole(
    provider,
    {
      org: orgPda,
      authority: payer.publicKey,
      name: roleName,
    },
    { signers: [] }
  );
  console.log(`[create_role] role=${rolePda.toBase58()} tx=${createRoleSig}`);

  // 3. assign_role (no expiry)
  const assignRoleSig = await sendAssignRole(
    provider,
    {
      role: rolePda,
      holder: holder.publicKey,
      admin: payer.publicKey,
      expiresAt: null,
    },
    { signers: [] }
  );
  console.log(
    `[assign_role] member=${memberPda.toBase58()} tx=${assignRoleSig}`
  );

  // 4. check_role -- read back the resulting PDAs to prove state.
  const memberAccount = await program.account.member.fetch(memberPda);
  const roleAccount = await program.account.role.fetch(rolePda);
  console.log(
    `[check_role:state] role.enabled=${
      roleAccount.enabled
    } role.memberCount=${roleAccount.memberCount.toString()} member.holder=${memberAccount.holder.toBase58()} member.expiresAt=${memberAccount.expiresAt.toString()}`
  );

  const checkRoleSig = await sendCheckRole(
    provider,
    {
      role: rolePda,
      holder: holder.publicKey,
    },
    { signers: [] }
  );
  console.log(
    `[check_role] verified holder=${holder.publicKey.toBase58()} tx=${checkRoleSig}`
  );

  // 5. set_role_enabled(false)
  const setRoleEnabledSig = await sendSetRoleEnabled(
    provider,
    {
      role: rolePda,
      admin: payer.publicKey,
      enabled: false,
    },
    { signers: [] }
  );
  console.log(
    `[set_role_enabled] role=${rolePda.toBase58()} enabled=false tx=${setRoleEnabledSig}`
  );

  const disabledRoleAccount = await program.account.role.fetch(rolePda);
  if (disabledRoleAccount.enabled) {
    throw new Error(
      `Expected role ${rolePda.toBase58()} to be disabled after set_role_enabled.`
    );
  }
  console.log(`[set_role_enabled:state] role.enabled=false`);

  // 6. revoke_role
  const revokeRoleSig = await sendRevokeRole(
    provider,
    {
      role: rolePda,
      holder: holder.publicKey,
      admin: payer.publicKey,
    },
    { signers: [] }
  );
  console.log(
    `[revoke_role] member=${memberPda.toBase58()} tx=${revokeRoleSig}`
  );

  const memberClosed = await connection.getAccountInfo(memberPda);
  if (memberClosed !== null) {
    throw new Error(
      `Expected member PDA ${memberPda.toBase58()} to be closed after revoke_role, but it still exists.`
    );
  }
  console.log(`[revoke_role:state] member PDA closed, rent returned to admin`);

  console.log("six-instruction lifecycle OK on devnet");
}

main().catch((err) => {
  console.error("[error] demo failed:");
  console.error(err);
  process.exit(1);
});
