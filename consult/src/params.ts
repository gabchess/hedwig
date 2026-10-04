// The Params type, its shape guard, checkParam, and the reader a Condition
// gets as `context.param`. No value lives here or anywhere in this package:
// every number a Check compares against arrives at run time as
// `facts.params`, supplied by the service that runs consult. The core takes
// `params` out of `facts` before any Condition runs, so the bundle is never a
// value a Condition is handed: it asks `context.param(id, key)` for one
// constant. Without the bundle, a Check that needs a number answers
// UNVERIFIED, which folds to UNKNOWN.
//
// Limit, stated as a class: code that runs in the same process can still
// reach the bundle. It can patch a built-in or a module export (a patch made
// during one call catches the bundle on the next), or read the heap through
// `node:inspector` or `node:v8`. consult does not defend against this. The
// caller must also not alias the bundle: a reference to it under another key
// of `facts`, or kept elsewhere, is not taken out. Closing the same-process
// class needs a separate realm, which is out of scope.
//
// This file imports nothing, so the service can load it with Node's type
// stripping alone, with no install.
//
// Each constant carries the params file's own fields (`value`, `unit`,
// `used_by`) and its provenance (`id`, `asOf`, `paramsSha256`, `scrub`). Any
// other field in the file is passed through untouched.

// The `used_by` labels a Check may read. Every other label, known or not,
// is never returned to a Check. The service that generates the values owns
// the full label set and refuses a label outside it.
const CHECK_READABLE: readonly string[] = ["check", "both"];

export interface ParamScrub {
  readonly reviewer: string;
  readonly date: string;
  readonly sha256: string;
}

export interface ParamConstant {
  readonly value: unknown;
  readonly unit: string;
  readonly id: string;
  readonly asOf: string;
  readonly paramsSha256: string;
  readonly scrub: ParamScrub;
  readonly used_by: string;
  readonly [field: string]: unknown;
}

// Keyed by params id, then by constant name.
export interface Params {
  readonly [paramsId: string]: { readonly [key: string]: ParamConstant };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function isScrub(value: unknown): value is ParamScrub {
  return (
    isRecord(value) &&
    isNonEmptyString(value.reviewer) &&
    isNonEmptyString(value.date) &&
    typeof value.sha256 === "string" &&
    SHA256_HEX.test(value.sha256)
  );
}

function isConstant(value: unknown, paramsId: string): value is ParamConstant {
  return (
    isRecord(value) &&
    "value" in value &&
    value.value !== undefined &&
    value.value !== null &&
    isNonEmptyString(value.unit) &&
    value.id === paramsId &&
    isNonEmptyString(value.asOf) &&
    typeof value.paramsSha256 === "string" &&
    SHA256_HEX.test(value.paramsSha256) &&
    isScrub(value.scrub) &&
    isNonEmptyString(value.used_by)
  );
}

// All or nothing: one malformed constant anywhere makes the whole value
// fail, so a partial `facts.params` counts as absent.
export function isParams(value: unknown): value is Params {
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).every((paramsId) => {
    const file = value[paramsId];
    return (
      isRecord(file) &&
      Object.keys(file).every((key) => isConstant(file[key], paramsId))
    );
  });
}

// A constant a v1 Check may compare against, or undefined. Undefined when
// `params` is absent, malformed or partial, when the constant is missing, or
// when its label is not `check` or `both`. The caller answers UNVERIFIED.
export function checkParam(
  params: unknown,
  paramsId: string,
  key: string
): ParamConstant | undefined {
  if (
    !isParams(params) ||
    !Object.prototype.hasOwnProperty.call(params, paramsId)
  ) {
    return undefined;
  }
  const file = params[paramsId];
  if (!Object.prototype.hasOwnProperty.call(file, key)) {
    return undefined;
  }
  const constant = file[key];
  return CHECK_READABLE.includes(constant.used_by) ? constant : undefined;
}

// The params file the three market-signal Conditions read.
export const UNKNOWN_TOKEN_PARAMS_ID =
  "defi-param-unknown-token-thresholds.json";

// Every constant a Condition may read, as [params id, key]. `context.param`
// returns undefined for a pair not listed here, so this list is the whole set
// of constants consult can read, and the used-by check reads it as data. A
// Check adds its pair here when it starts reading one.
export const PARAM_READS: readonly (readonly [string, string])[] =
  Object.freeze(
    [
      "liquidity_abs_deny_below_usd",
      "liquidity_abs_pass_at_or_above_usd",
      "holders_deny_below",
      "holders_pass_at_or_above",
      "activity_window_hours",
      "activity_min_distinct_counterparties",
      "activity_recent_event_max_age_hours",
      "qualifying_event_min_usd",
    ].map((key) => Object.freeze([UNKNOWN_TOKEN_PARAMS_ID, key] as const))
  );

export type ParamReader = (
  paramsId: string,
  key: string
) => ParamConstant | undefined;

// The reader the core hands each Condition as `context.param`. The bundle
// stays in this closure: a Condition gets one constant, label-filtered by
// checkParam, for a listed pair, and nothing else.
export function paramReader(
  params: unknown,
  reads: readonly (readonly [string, string])[]
): ParamReader {
  return (paramsId, key) =>
    reads.some(([id, k]) => id === paramsId && k === key)
      ? checkParam(params, paramsId, key)
      : undefined;
}

// The used-by check: every listed pair must name a `check` or `both` constant
// in the bundle. Public CI runs it against the fixture bundle; the service
// runs it against its generated params.
export function paramReadViolations(
  reads: readonly (readonly [string, string])[],
  params: unknown
): string[] {
  if (!isParams(params)) {
    return ["the bundle is not a Params value"];
  }
  return reads.flatMap(([id, key]) => {
    const file = Object.prototype.hasOwnProperty.call(params, id)
      ? params[id]
      : undefined;
    if (
      file === undefined ||
      !Object.prototype.hasOwnProperty.call(file, key)
    ) {
      return [`${id} ${key}: not in the bundle`];
    }
    const label = file[key].used_by;
    return CHECK_READABLE.includes(label)
      ? []
      : [`${id} ${key}: labelled ${label}`];
  });
}
