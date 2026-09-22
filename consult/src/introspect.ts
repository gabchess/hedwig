// A read-only door onto the catalog consult() binds to, for a caller that
// wants to describe the checklist rather than run it (documentation
// generators, offline evals, an agent's own reference material). This
// module exposes no checker function and no mutable object: describeCatalog
// returns plain data, deep-frozen before it leaves the function, built fresh
// from the same catalog.ts tables consult() itself uses. `consultWith` and
// every other internal export stay out of this file on purpose; index.ts
// (the package door) never re-exports it either, so a caller only reaches
// it through the dedicated `@hedwig/consult/introspect` subpath.
import {
  CANONICAL_ASSETS,
  CANONICAL_ROUTERS,
  CANONICAL_ROUTER_NAME,
  CATALOG,
  deepFreeze,
  passCodesOf,
} from "./catalog";
import type { ConditionDefinition } from "./catalog";

export interface CatalogConditionDescription {
  readonly id: string;
  // Almost every Condition runs for exactly one action type; the list stays
  // an array so a future Condition that legitimately runs for more than one
  // (same question, reference, floor flag, and codes) is still one row.
  readonly actionTypes: readonly string[];
  readonly floor: boolean;
  readonly question: string;
  readonly codes: {
    readonly pass: readonly string[];
    readonly fail: readonly string[];
    readonly unverified: readonly string[];
  };
  readonly evidenceClass: Readonly<Record<string, string>>;
  readonly reference: string;
}

export interface CatalogDescription {
  readonly actionTypes: readonly string[];
  readonly conditions: readonly CatalogConditionDescription[];
  // chainId -> symbol -> contract address.
  readonly canonicalAssets: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  // chainId -> router name -> contract address.
  readonly canonicalRouters: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}

// Two Condition definitions describe the exact same check only when every
// caller-visible field matches; `check` (a function) is deliberately left
// out of the key, since a description can never carry a function anyway.
function conditionKey(definition: ConditionDefinition): string {
  return JSON.stringify({
    id: definition.id,
    isFloor: definition.isFloor,
    question: definition.question,
    reference: definition.reference,
    pass: [...passCodesOf(definition.codes)],
    fail: definition.codes.fail,
    unverified: definition.codes.unverified,
    codeEvidenceClass: definition.codeEvidenceClass,
  });
}

function describeConditions(): CatalogConditionDescription[] {
  const byKey = new Map<
    string,
    { actionTypes: string[]; definition: ConditionDefinition }
  >();
  for (const [actionType, definitions] of Object.entries(CATALOG)) {
    for (const definition of definitions) {
      const key = conditionKey(definition);
      const existing = byKey.get(key);
      if (existing) {
        existing.actionTypes.push(actionType);
      } else {
        byKey.set(key, { actionTypes: [actionType], definition });
      }
    }
  }
  return [...byKey.values()].map(({ actionTypes, definition }) => ({
    id: definition.id,
    actionTypes: [...actionTypes],
    floor: definition.isFloor,
    question: definition.question,
    codes: {
      pass: [...passCodesOf(definition.codes)],
      fail: [...definition.codes.fail],
      unverified: [...definition.codes.unverified],
    },
    evidenceClass: { ...definition.codeEvidenceClass },
    reference: definition.reference,
  }));
}

function describeCanonicalAssets(): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const [chainId, bySymbol] of Object.entries(CANONICAL_ASSETS)) {
    result[chainId] = { ...bySymbol };
  }
  return result;
}

function describeCanonicalRouters(): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const [chainId, address] of Object.entries(CANONICAL_ROUTERS)) {
    result[chainId] = { [CANONICAL_ROUTER_NAME]: address };
  }
  return result;
}

/**
 * Describes the catalog this package binds `consult()` to: every
 * Condition's id, which action type(s) it runs for, whether it is Floor,
 * its question, its declared codes and their evidence classes, and its
 * reference path, plus the canonical asset and router tables the Floor
 * checks compare requests against.
 *
 * The returned structure carries no checker function and cannot be
 * mutated: it is a fresh object on every call, deep-frozen before it is
 * returned, built only from data already public elsewhere in this package.
 */
export function describeCatalog(): CatalogDescription {
  return deepFreeze({
    actionTypes: Object.keys(CATALOG),
    conditions: describeConditions(),
    canonicalAssets: describeCanonicalAssets(),
    canonicalRouters: describeCanonicalRouters(),
  });
}
