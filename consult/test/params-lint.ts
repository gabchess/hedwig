// The used-by lint. A v1 Check may read only constants labelled `check` or
// `both`. The lint maps every constant a Condition reads to its label and
// fails on anything else. Public CI runs it against the fixture bundle; the
// service that supplies `facts.params` runs it against its own values. This
// file imports nothing, so that service can load it directly.
//
// Limit: this is a text scan, not a parser. It rejects a direct `params`
// read and any index on `facts` or `Reflect.get(facts, ...)` whose key is
// not one plain string literal. The receiver may be parenthesized, cast
// (`as T`, `satisfies T`, `<T>`) or non-null (`!`). It does not catch an alias
// of `facts`, `Object.entries(facts)`, a spread of `facts`,
// `JSON.stringify(facts)`, a receiver that is another expression such as
// `(facts ?? {})`, or a `Reflect.get` reached through `call`, `apply` or a
// copy. It does not catch `context["facts"]` (a string key is blanked, so it
// is not told from any other), a helper that takes `facts` as an argument
// (`ownLookup(facts as object, k)`), computed destructuring of `facts`, or
// `Object.getOwnPropertyDescriptor(facts, k)`. A cast to an object-literal
// type, `typeof`, `keyof`, a parenthesized union or generics nested three
// levels deep is not stripped, so the receiver behind it is not seen.
// Closing those needs `params` out of `context.facts`, with its own channel
// for `checkParam`.

const READ_CALL =
  /checkParam\(\s*[^,()]+?\s*,\s*"([^"\\]+)"\s*,\s*"([^"\\]+)"\s*\)/g;
const ANY_CALL = /checkParam\(/g;
const PARAMS_IMPORT = /^\s*import\b[^;]*\bfrom\s+["']\.\/params["'];?\s*$/gm;
const LINE_COMMENT = /^\s*\/\/.*$/gm;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
// Single- and double-quoted strings only. Template literals stay, so a read
// hidden in a `${...}` interpolation is still caught. A string whose content
// is exactly `params` keeps the word, so `facts["params"]` and
// `Reflect.get(facts, "params")` are caught too.
const PLAIN_STRING = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
// A string with an escape (`"\u0070arams"`) cannot be read without parsing,
// so it blanks to a marker that no plain-literal key matches.
const blankString = (s: string): string => {
  const content = s.slice(1, -1);
  return content === "params"
    ? "params"
    : content.includes("\\")
    ? '"x"'
    : '""';
};
const PARAMS_WORD = /\bparams\b/;
// After strings are blanked, a key built by concatenation or interpolation
// no longer spells `params`. So an index on `facts`, or `Reflect.get(facts`,
// passes only when its key is exactly one plain string literal.
const TYPE_ATOM = String.raw`[\w$.]+(?:<[^<>()\n]*(?:<[^<>()\n]*>[^<>()\n]*)*>)?(?:\[\])*`;
// Casts leave the receiver unchanged, so they are also removed for a second
// scan: `facts as T`, `facts satisfies T` and `<T>facts`. The `<T>` branch
// matches only where an assertion can start, never after an operand, so a
// comparison such as `a < facts.x && b > facts.y` is not a cast.
const CAST = new RegExp(
  String.raw`\s(?:as|satisfies)\s+${TYPE_ATOM}(?:\s*[|&]\s*${TYPE_ATOM})*|(?<![\w$)\]]\s*)<(?:[^<>()\n]|<[^<>()\n]*>)*>\s*(?=facts\b)`,
  "g"
);
// After a cast is removed, the receiver is `facts` plus any run of closing
// parentheses, `!` and spaces.
const FACTS_COMPUTED =
  /\bfacts[\s)!]*(?:\?\.)?\s*\[(?!\s*""\s*\])|\bReflect\s*(?:\??\.\s*get|\??\.?\s*\[[^\]]*\])\s*(?:\?\.)?\(\s*[(\s]*(?:[\w$]+\.)*facts[\s)!]*,(?!\s*""\s*\))/;

const CHECK_READABLE = ["check", "both"];

function labelOf(params: unknown, id: string, key: string): unknown {
  if (params === null || typeof params !== "object") {
    return undefined;
  }
  const file = Object.prototype.hasOwnProperty.call(params, id)
    ? (params as Record<string, unknown>)[id]
    : undefined;
  if (file === null || typeof file !== "object") {
    return undefined;
  }
  const constant = Object.prototype.hasOwnProperty.call(file, key)
    ? (file as Record<string, unknown>)[key]
    : undefined;
  if (constant === null || typeof constant !== "object") {
    return undefined;
  }
  return (constant as Record<string, unknown>).used_by;
}

// `sources` maps a file name to its source text. Returns one line per
// problem; an empty list passes.
export function usedByViolations(
  sources: Record<string, string>,
  params: unknown
): string[] {
  const problems: string[] = [];
  for (const [file, source] of Object.entries(sources)) {
    const stripped = source
      .replace(BLOCK_COMMENT, "")
      .replace(LINE_COMMENT, "");
    const reads = [...stripped.matchAll(READ_CALL)];
    const calls = stripped.match(ANY_CALL)?.length ?? 0;
    if (calls !== reads.length) {
      problems.push(
        `${file}: ${
          calls - reads.length
        } checkParam call(s) without a literal params id and key`
      );
    }
    for (const [, id, key] of reads) {
      const label = labelOf(params, id, key);
      if (typeof label !== "string") {
        problems.push(
          `${file}: reads ${id} ${key}, which has no used_by label`
        );
      } else if (!CHECK_READABLE.includes(label)) {
        problems.push(`${file}: reads ${id} ${key}, labelled ${label}`);
      }
    }
    const rest = stripped
      .replace(READ_CALL, "")
      .replace(PARAMS_IMPORT, "")
      .replace(PLAIN_STRING, blankString);
    // The text is scanned as written and with casts removed. A cast removal
    // must never hide a read that is plain in the original.
    const touches = (text: string): boolean =>
      PARAMS_WORD.test(text) || FACTS_COMPUTED.test(text);
    if (
      calls === reads.length &&
      (touches(rest) || touches(rest.replace(CAST, "")))
    ) {
      problems.push(`${file}: touches params outside a checkParam call`);
    }
  }
  return problems;
}
