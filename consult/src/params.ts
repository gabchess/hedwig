// The Params type, its shape guard, and checkParam, the one way a Condition
// reads a domain number. No value lives here or anywhere in this package:
// every number a Check compares against arrives at run time as
// `facts.params`, supplied by the service that runs consult. Without it, a
// Check that needs a number answers UNVERIFIED, which folds to UNKNOWN.
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
