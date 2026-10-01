# Hedwig devnet operations

This runbook covers the current devnet program only. It does not make the
single-key upgrade authority suitable for mainnet.

Program ID:
`H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC`

Reference consumer:
`52D3pTYvMwLYbiigY5xg55n4HmtEzTKCEicx1Cojzo9a`

Current upgrade authority:
`2kJM7w8aqZFiYse47Jke9xhNLhZcV9E5jqLUFVrpKCv7`

## Before an upgrade

1. Freeze the reviewed source commit.
2. Build the consumer first and Hedwig last.
3. Record the Hedwig artifact SHA-256 and byte length.
4. Verify that the configured signer exactly matches the live authority.
5. Dump the current live binary, record its SHA-256, and keep that file until
   the new deployment and demo pass.
6. Run the audit and ship-gate evidence. Stop on any unexplained failure.

Never infer the target from `target/deploy/hedwig_sol-keypair.json`. It does not
derive the fixed devnet program ID.

## Upgrade

Use the fixed address and reviewed artifact explicitly:

```bash
solana program deploy target/deploy/hedwig_sol.so \
  --program-id H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC \
  --url devnet
```

Do not transfer authority, freeze the program, or change clusters as part of
this command.

## Verify

1. Query the program account and require the authority to be unchanged.
2. Dump the live binary and prove deployed-code identity. If the loader account
   is the same length as the reviewed ELF, require a full `cmp`. If Agave
   allocated a larger ProgramData account, require the ELF-length prefix to
   match and every trailing allocation byte to be zero:

   ```bash
   elf_size=$(wc -c < target/deploy/hedwig_sol.so | tr -d ' ')
   live_size=$(wc -c < /tmp/hedwig-live.so | tr -d ' ')
   test "$live_size" -ge "$elf_size"
   cp /tmp/hedwig-live.so /tmp/hedwig-live-prefix.so
   truncate -s "$elf_size" /tmp/hedwig-live-prefix.so
   cmp target/deploy/hedwig_sol.so /tmp/hedwig-live-prefix.so
   od -An -v -tu1 -j "$elf_size" /tmp/hedwig-live.so |
     awk '{for(i=1;i<=NF;i++) if($i!=0) bad=1} END{exit bad}'
   ```

   A zero-padded copy of the reviewed ELF may also be compared against the
   entire live dump. Record both the compiled ELF hash and the padded
   account-image hash.

3. Record both hashes, deployment slot, and transaction signature.
4. Run the SDK-driven six-instruction demo with a fresh funded devnet wallet.
5. Require the Role to read `enabled=false` after the sixth surface is called
   and the Member account to be absent after revoke.

## Reference consumer deployment

The consumer was first deployed on 2026-07-24. Its ignored generated deploy
keypair derives the declared program ID. Confirm that relationship before an
initial deployment:

```bash
solana-keygen pubkey target/deploy/hedwig_consumer-keypair.json
```

The output must equal
`52D3pTYvMwLYbiigY5xg55n4HmtEzTKCEicx1Cojzo9a`. Build and run the full workspace
suite before deployment, then use:

```bash
solana program deploy target/deploy/hedwig_consumer.so \
  --program-id target/deploy/hedwig_consumer-keypair.json \
  --url devnet
```

For later upgrades, query the live program first, pin the fixed program ID, and
apply the same artifact/live-dump comparison used for Hedwig. Never create a new
keypair or address for an upgrade.

After deployment, run:

```bash
cd app
npm run consumer-demo
```

Require the final counter account to be owned by the consumer, store the
authenticated actor and expected Hedwig role, and contain value `1`. Record the
deployment, artifact hash, proof transactions, and final state in a dated
promotion record.

## Roll back

Use rollback only if the new binary fails post-deploy verification or the live
demo exposes a release defect.

1. Stop integrations from sending new transactions.
2. Reconfirm that the saved pre-upgrade binary hash matches the promotion
   record.
3. Deploy that exact saved binary with the same explicit program ID and current
   authority.
4. Dump the live program again and apply the same ELF-prefix and zero-tail
   identity proof. ProgramData can remain larger than the rollback ELF.
5. Record the rollback transaction, slot, hashes, reason, and failed check.

This release changes program logic without changing the account layout. A
future state migration needs its own data rollback design before deployment.

## Suspected compromise

This covers unexpected program or authority changes and offchain compromise of
RPC credentials, SDK dependencies, CI, or a deploy workstation.

1. Stop deployment work and preserve CLI output, transaction signatures,
   binaries, hashes, dependency locks, CI logs, and relevant local logs. Copy
   evidence to a restricted location, hash each file, and record its source,
   collection time, and collector before analysis.
2. Query the program account and compare the authority, slot, and live binary
   hash with the last promotion record.
3. If the existing logic is trusted and one role is affected, its admin can
   disable that role as a narrow circuit breaker.
4. If the program binary or upgrade authority changed without approval, warn
   integrators not to trust Hedwig checks until a reviewed recovery completes.
5. Open a private GitHub security advisory or request a private maintainer
   channel. Do not publish exploit details first.
6. Rotate any exposed RPC credential, stop untrusted CI releases, and restore
   dependencies only from reviewed lockfiles and known-good sources.
7. After containment, write a dated internal incident record with the timeline,
   cause, impact, evidence, remediation, and lessons learned. Track each
   follow-up with an owner, due date, and closure evidence.

## Emergency hotfix

An urgent fix still requires an explicit deployment decision, a named source
commit, focused regression tests, both SBF builds, artifact hash, and the
post-deploy identity proof above. Record any skipped lower-severity gate before
deployment and close it in the incident follow-up. Never use the hotfix path to
change cluster, program ID, authority custody, or account layout without a
separate reviewed plan.

There is no automated upgrade watcher, paging channel, tested key-recovery path,
or multisig today. These remain explicit mainnet blockers.
