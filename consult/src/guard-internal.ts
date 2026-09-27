// The Trigger guard's own verdict computation, parameterised over the
// consult() implementation only so a test can prove the guard's defensive
// branches (a consult() that throws, a consult() that answers with a
// malformed verdict) without touching the money path itself. guard.ts, the
// guard's public door, always binds this to the real consult(): a caller
// who could substitute the verdict function would control the verdict.
// Never exported through package.json.
import { deepFreeze, truncate } from "./catalog";
import { MAX_INPUT_JSON_LENGTH } from "./constants";
import type { ConsultAction, ConsultRequest, Policy } from "./catalog";
import type { ConsultResponse } from "./core";
import type { Verdict } from "./fold";

export type ConsultFn = (
  request: ConsultRequest,
  policy: Policy,
  facts?: unknown
) => ConsultResponse;

const KNOWN_VERDICTS: ReadonlySet<Verdict> = new Set([
  "ALLOW_UNDER_POLICY",
  "DENY",
  "UNKNOWN",
]);

// The reference path and question the guard puts on its own UNKNOWN-shaped
// results, beside the literal id "trigger-guard" in unknownGuardResult, so a
// reader can tell a guard-level failure apart from an UNKNOWN the guard
// passed through from consult(). The reference path is the same one core
// results use.
const GUARD_REFERENCE = "consult/references/core.md";
const GUARD_QUESTION =
  "Did the guard reach a mapped request, facts in time, and a well-formed verdict?";

export const DEFAULT_GATHER_DEADLINE_MS = 800;
export const DEFAULT_SIGNER_DEADLINE_MS = 5000;

// "not-attempted": the verdict was not ALLOW_UNDER_POLICY, or the guard
// failed before ever reaching the signer. "settled": the signer returned,
// or its promise resolved, inside its deadline; signerResult carries its
// value. "unknown": the signer was called and then missed its deadline,
// threw, or rejected. Once the signer has been called, the guard cannot
// unsign, so this is never retried and never guessed at as success or
// failure.
export type SignerOutcome = "not-attempted" | "settled" | "unknown";

export interface TriggerGuardResult<TSignerResult> {
  readonly consult: ConsultResponse;
  readonly signerOutcome: SignerOutcome;
  readonly signerResult?: TSignerResult;
}

export interface TriggerGuardInput<TPayment, TSignerResult> {
  // The caller's own payment shape. The guard never inspects it itself.
  readonly payment: TPayment;
  // Maps payment into the ConsultRequest the guard turns into frozen JSON
  // data once, right after this returns. Runs once; a throw here never
  // reaches gather, consult() or the signer.
  readonly toRequest: (payment: TPayment) => ConsultRequest;
  readonly policy: Policy;
  // Optional: produces the Facts the guard passes to consult() (a role
  // fact, for example), called with the frozen JSON snapshot the guard made
  // of the mapped request. Omitted entirely, the guard passes no facts. A
  // throw or a miss of gatherDeadlineMs both count as a guard-level
  // failure: no consult() call, no signer call, an UNKNOWN-shaped result.
  readonly gather?: (request: ConsultRequest) => unknown;
  readonly gatherDeadlineMs?: number;
  // Called at most once, only on ALLOW_UNDER_POLICY, with the action field
  // of the same frozen JSON snapshot the guard passed to gather and consult(),
  // never the caller's own live object. Its records have null prototypes:
  // read fields with Object.hasOwn or a spread, never
  // action.hasOwnProperty, which a null-prototype object does not have.
  readonly signer: (
    action: ConsultAction
  ) => TSignerResult | Promise<TSignerResult>;
  readonly signerDeadlineMs?: number;
}

// A hostile thrown value must never itself throw while being turned into
// evidence text. The whole body runs under one try/catch, including the
// `instanceof` check itself: a revoked Proxy or a getPrototypeOf trap that
// throws can make `instanceof Error` throw before any property is even
// read. `.message` is read exactly once into a local: reading it twice (a
// typeof check, then the return) lets a getter answer a string the first
// time and something else the second, and a getter can also just throw.
// Every other unreadable shape (a null-prototype object with no toString,
// a toString that returns a non-primitive, a thrown Symbol) falls through
// to the generic String(error) call in the same try.
function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = error.message;
      return typeof message === "string" ? message : "non-string error message";
    }
    return String(error);
  } catch {
    return "unstringifiable thrown value";
  }
}

// Truncated and frozen at every level: a guard-level failure is still a
// ConsultResponse a caller can hold onto, and evidence here can come from
// raw, caller-controlled error text.
function unknownGuardResult<TSignerResult>(
  code: string,
  evidence: string
): TriggerGuardResult<TSignerResult> {
  const cappedEvidence = truncate(
    evidence.startsWith("cannot confirm")
      ? evidence
      : `cannot confirm: ${evidence}`
  );
  return {
    consult: deepFreeze({
      question:
        "Should this agent proceed with this action under the owner's policy?",
      proceed: false,
      verdict: "UNKNOWN",
      support: 0,
      band: "red",
      results: [
        {
          id: "trigger-guard",
          question: GUARD_QUESTION,
          status: "UNVERIFIED",
          code,
          evidence: cappedEvidence,
          evidenceClass: "not-verifiable",
          reference: GUARD_REFERENCE,
        },
      ],
      floorIds: [],
      advisory: true,
    }),
    signerOutcome: "not-attempted",
  };
}

// setTimeout's own ceiling (2^31 - 1 ms): Node fires a timer with a longer
// delay, or a NaN one, after 1ms instead. A NaN or Infinity deadline also
// disables raceWithDeadline's own elapsed-time check (elapsed >= NaN and
// elapsed >= Infinity are both always false), so a synchronous overrun
// would sail through uncaught. A bad deadline fails the guard closed
// instead of silently becoming "no deadline at all".
const MAX_TIMEOUT_MS = 2147483647;

function isValidDeadlineMs(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_TIMEOUT_MS;
}

// JSON.parse reviver: gives every parsed record a null prototype, so
// reading a field the parsed text did not hold returns undefined instead of
// looking it up on Object.prototype. Arrays keep Array.prototype.
function nullPrototypeRecords(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.setPrototypeOf(value, null);
  }
  return value;
}

// Turns the mapped request into its own JSON snapshot. The guard writes the
// mapped request to JSON text with JSON.stringify and a replacer that
// counts values and primitive string lengths, rejects text over the size
// limit, parses the text back with the reviver above, and deep-freezes
// the result.
//
// Values that aren't plain JSON follow JSON.stringify's own rules; the
// parsed records have null prototypes, and the whole result is frozen.
// JSON.stringify throws on a BigInt with no toJSON, on a cycle, and on a
// getter or toJSON that throws; the caller turns that throw into
// GUARD_MAPPING_FAILED. Code running in the Caller's process can patch
// JSON.stringify itself or any toJSON method it calls, and the guard then
// checks and signs whatever that patched code writes; THREAT-MODEL.md
// covers that trust boundary.
//
// JSON writes a shared reference out once per path that reaches it, so a
// small object graph can produce very long text. The replacer runs before
// JSON writes each value. It adds 1 for every value, plus the length of
// every primitive string value, plus the length of every record key (array
// indexes are not written, so they are not counted), and throws once that
// total passes MAX_INPUT_JSON_LENGTH. When JSON.stringify returns, the
// text-length check before JSON.parse rejects text longer than the same
// limit consult() enforces.
function toSnapshotData(request: ConsultRequest): ConsultRequest {
  let counted = 0;
  const text = JSON.stringify(
    request,
    function (this: unknown, key: string, value: unknown) {
      counted += 1;
      if (!Array.isArray(this)) counted += key.length;
      if (typeof value === "string") counted += value.length;
      if (counted > MAX_INPUT_JSON_LENGTH) {
        throw new RangeError(
          "the mapped request's JSON passed the size limit while being written"
        );
      }
      return value;
    }
  );
  if (typeof text !== "string") {
    throw new TypeError("the mapped request has no JSON form");
  }
  if (text.length > MAX_INPUT_JSON_LENGTH) {
    throw new RangeError("the mapped request's JSON exceeds the size limit");
  }
  return deepFreeze(JSON.parse(text, nullPrototypeRecords)) as ConsultRequest;
}

// Formats a deadline for evidence text without ever calling String() on a
// caller-supplied object, which can throw.
function describeDeadline(value: unknown): string {
  return typeof value === "number" ? String(value) : typeof value;
}

type RaceResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "error"; error: unknown }
  | { ok: false; reason: "timeout" };

// Races fn's own settlement, sync throw or async, against deadlineMs.
// Never rejects: every outcome comes back as one RaceResult. A fn that
// settles after the deadline has already lost the race; its late
// resolution or rejection is still awaited here so it can never become an
// unhandled promise rejection, but the caller has already moved on and
// this function never calls fn a second time.
function raceWithDeadline<T>(
  fn: () => T | Promise<T>,
  deadlineMs: number
): Promise<RaceResult<T>> {
  const start = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: "timeout" });
    }, deadlineMs);

    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // A synchronous fn that overran the deadline blocks the event
          // loop, so the timer above can never fire first: it is only
          // ever checked once fn already returned. Wall-clock elapsed
          // time is what actually caught the overrun, not the timer.
          if (performance.now() - start >= deadlineMs) {
            resolve({ ok: false, reason: "timeout" });
            return;
          }
          resolve({ ok: true, value });
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, reason: "error", error });
        }
      );
  });
}

// The Trigger guard: maps a payment into a request, turns it into frozen
// JSON data once, gathers facts from that data within a deadline, passes
// the same data to consultFn, and calls the signer only when consultFn
// returns ALLOW_UNDER_POLICY, with checked.action: the action field of
// that same data. Nothing after that step re-derives it.
export async function runTriggerGuardWith<TPayment, TSignerResult>(
  consultFn: ConsultFn,
  input: TriggerGuardInput<TPayment, TSignerResult>
): Promise<TriggerGuardResult<TSignerResult>> {
  let request: ConsultRequest;
  try {
    request = input.toRequest(input.payment);
  } catch (error) {
    return unknownGuardResult("GUARD_MAPPING_FAILED", errorMessage(error));
  }

  // The guard turns the mapped request into its own JSON snapshot once,
  // synchronously, right after toRequest returns and before gather runs.
  // gather and consultFn receive that same data; the signer receives only
  // its action field. The guard never reads `request` again. A request
  // with no JSON form is a guard-level mapping failure: no gather,
  // consultFn or signer call.
  let checked: ConsultRequest;
  try {
    checked = toSnapshotData(request);
  } catch (error) {
    return unknownGuardResult("GUARD_MAPPING_FAILED", errorMessage(error));
  }

  let facts: unknown;
  if (input.gather) {
    const gatherDeadlineMs =
      input.gatherDeadlineMs ?? DEFAULT_GATHER_DEADLINE_MS;
    if (!isValidDeadlineMs(gatherDeadlineMs)) {
      return unknownGuardResult(
        "GUARD_GATHER_DEADLINE_INVALID",
        `gatherDeadlineMs ${describeDeadline(
          gatherDeadlineMs
        )} is not a finite number of milliseconds from 0 to ${MAX_TIMEOUT_MS}`
      );
    }
    const gather = input.gather;
    const gathered = await raceWithDeadline(
      () => gather(checked),
      gatherDeadlineMs
    );
    if (!gathered.ok) {
      return unknownGuardResult(
        gathered.reason === "timeout"
          ? "GUARD_GATHER_TIMED_OUT"
          : "GUARD_GATHER_FAILED",
        gathered.reason === "timeout"
          ? "facts were not gathered in time"
          : errorMessage(gathered.error)
      );
    }
    facts = gathered.value;
  }

  let response: ConsultResponse;
  try {
    response = consultFn(checked, input.policy, facts);
  } catch (error) {
    return unknownGuardResult("GUARD_CONSULT_THREW", errorMessage(error));
  }

  if (!response || !KNOWN_VERDICTS.has(response.verdict)) {
    return unknownGuardResult(
      "GUARD_MALFORMED_VERDICT",
      "consult() returned an unrecognised verdict"
    );
  }

  if (response.verdict !== "ALLOW_UNDER_POLICY") {
    return { consult: response, signerOutcome: "not-attempted" };
  }

  const action = checked.action;
  const signerDeadlineMs = input.signerDeadlineMs ?? DEFAULT_SIGNER_DEADLINE_MS;
  if (!isValidDeadlineMs(signerDeadlineMs)) {
    return unknownGuardResult(
      "GUARD_SIGNER_DEADLINE_INVALID",
      `signerDeadlineMs ${describeDeadline(
        signerDeadlineMs
      )} is not a finite number of milliseconds from 0 to ${MAX_TIMEOUT_MS}`
    );
  }
  const signed = await raceWithDeadline(
    () => input.signer(action),
    signerDeadlineMs
  );

  if (!signed.ok) {
    return { consult: response, signerOutcome: "unknown" };
  }

  return {
    consult: response,
    signerOutcome: "settled",
    signerResult: signed.value,
  };
}
