import type { EvidenceClass } from "./fold";

// The only place a numeric cap or a scoring number is spelled out; every
// other module imports the name, never the literal.

// --- input bounds (unchanged behaviour, moved out of core.ts/catalog.ts) ---

// Each named extra condition id becomes a result, so the list and every id
// are bounded: a small request must never buy a large response.
export const MAX_EXTRA_CONDITIONS = 32;
export const MAX_CONDITION_ID_LENGTH = 64;

// A conservative ceiling well above any real request or policy.
export const MAX_INPUT_JSON_LENGTH = 64 * 1024;

// Evidence strings echo caller-supplied text; cap it so one hostile field
// cannot blow up a log or a report.
export const EVIDENCE_ECHO_LIMIT = 120;

// --- support score (consult/src/support.ts) ---

// How strong the proof behind a PASS is, strongest to weakest. A PASS can
// never legitimately rest on "not-verifiable" evidence.
export const EVIDENCE_CLASS_WEIGHTS: Readonly<Record<EvidenceClass, number>> =
  Object.freeze({
    "onchain-read": 1.0,
    "owner-policy": 0.9,
    "static-registry": 0.6,
    "not-verifiable": 0,
  });

// band edges: support >= BAND_GREEN_MIN is green, support < BAND_RED_MAX is
// red, everything between is amber.
export const BAND_GREEN_MIN = 0.8;
export const BAND_RED_MAX = 0.2;

// ALLOW_UNDER_POLICY always starts at BAND_GREEN_MIN (an earned ALLOW is
// never amber) and adds up to ALLOW_SUPPORT_SPAN more for how strong the
// weakest proof among the PASS rows is.
export const ALLOW_SUPPORT_SPAN = 1 - BAND_GREEN_MIN;

// An UNKNOWN verdict that a Floor did run for is scaled down by this factor
// so it can never reach BAND_GREEN_MIN (0.79 * 1 = 0.79 < 0.80): no amount
// of passing evidence turns an unearned verdict green.
export const UNKNOWN_WITH_FLOOR_FACTOR = 0.79;
