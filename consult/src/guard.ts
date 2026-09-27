// The Trigger guard's public door: the only way an external caller reaches
// the Trigger guard, and the only runtime export this subpath carries
// (beside its types). It binds runTriggerGuardWith to the real consult().
// runTriggerGuard takes no verdict function, so every verdict comes from
// the real consult(), or is the guard's own UNKNOWN when a guard-level step
// fails. See guard-internal.ts for the guard's own logic and
// consult/references/core.md for what PASS, FAIL and UNVERIFIED mean.
import { consult } from "./index";
import { runTriggerGuardWith } from "./guard-internal";
import type {
  SignerOutcome,
  TriggerGuardInput,
  TriggerGuardResult,
} from "./guard-internal";

export type { SignerOutcome, TriggerGuardInput, TriggerGuardResult };

export function runTriggerGuard<TPayment, TSignerResult>(
  input: TriggerGuardInput<TPayment, TSignerResult>
): Promise<TriggerGuardResult<TSignerResult>> {
  return runTriggerGuardWith(consult, input);
}
