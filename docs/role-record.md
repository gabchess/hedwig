# The role record

Give an agent a role with an expiry. An integrated program checks that role before a protected action. Revoking membership or disabling the role denies later actions that enforce the check.

The crate `hedwig_sol` and the package `@hedwig-sol/sdk` keep the names they had when this repository was called hedwig-sol, because the deployed evidence is bound to them.

## The six instructions

The program exports `create_org`, `create_role`, `assign_role`, `revoke_role`, `check_role` and `set_role_enabled`. The [architecture guide](access-control/architecture.md) describes the account model.

## Integrating with `check_role`

Your program must authenticate the actor and bind the supplied role to its configured required role before calling `check_role`. Membership alone does not prove that the caller controls the holder account.

The check returns success or a Hedwig error. Propagate that error to stop the protected action. The [integration guide](access-control/integration-guide.md) includes the compiling CPI consumer, negative tests and SDK flow.

Revocation applies through updated chain state, so it governs the actions ordered after it.

## Deployment records

- [Promotion record](deployment/evidence/2026-07-24-devnet-promotion.md)
- [Consumer integration](deployment/evidence/2026-07-24-consumer-devnet-integration.md)
- [September presence check](deployment/evidence/2026-09-06-program-presence.md)

## Running it

The command block in the [README](../README.md) builds this program and runs its tests. Build both SBF artifacts before the workspace tests. The tests run locally without a network connection. The [app guide](../app/README.md) covers running the lifecycle.
