// The used-by lint. A v1 Check may read only constants labelled `check` or
// `both`. The lint maps every constant a Condition reads to its label and
// fails on anything else. Public CI runs it against the fixture bundle; the
// service that supplies `facts.params` runs it against its own values. This
// file imports nothing, so that service can load it directly.

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
const blankString = (s: string): string =>
  s.slice(1, -1) === "params" ? "params" : '""';
const PARAMS_WORD = /\bparams\b/;

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
    if (calls === reads.length && PARAMS_WORD.test(rest)) {
      problems.push(`${file}: touches params outside a checkParam call`);
    }
  }
  return problems;
}
