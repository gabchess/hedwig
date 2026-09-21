#!/usr/bin/env bash

set -uo pipefail

repository_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "public-boundary: run this check from inside a Git repository" >&2
  exit 2
}
cd "$repository_root"

failed=0
checker_path="scripts/check-public-boundary.sh"

report_path_failure() {
  local path="$1"
  printf 'public-boundary: internal-only path is tracked: %s\n' "$path" >&2
  failed=1
}

while IFS= read -r -d '' tracked_path; do
  case "$tracked_path" in
    .gitignore | .prettierignore | .github/pull_request_template.md)
      ;;
    .github/workflows/*)
      relative_path="${tracked_path#.github/workflows/}"
      if [[ -z "$relative_path" || "$relative_path" == .* ]] || \
        [[ "$relative_path" == */* ]] || \
        [[ "$relative_path" != *.yml && "$relative_path" != *.yaml ]]; then
        report_path_failure "$tracked_path"
      fi
      ;;
    .cargo/*)
      relative_path="${tracked_path#.cargo/}"
      if [[ -z "$relative_path" || "$relative_path" == .* ]] || \
        [[ "$relative_path" == */* || "$relative_path" != *.toml ]]; then
        report_path_failure "$tracked_path"
      fi
      ;;
    .devcontainer/*)
      relative_path="${tracked_path#.devcontainer/}"
      if [[ -z "$relative_path" || "$relative_path" == .* ]] || \
        [[ "$relative_path" == */* || "$relative_path" != *.json ]]; then
        report_path_failure "$tracked_path"
      fi
      ;;
    .vscode/*)
      relative_path="${tracked_path#.vscode/}"
      if [[ -z "$relative_path" || "$relative_path" == .* ]] || \
        [[ "$relative_path" == */* || "$relative_path" != *.json ]]; then
        report_path_failure "$tracked_path"
      fi
      ;;
    .* | */.* | AGENTS.md | docs/adr/* | docs/superpowers/* | docs/sdk-rfc.md | docs/audits/*checklist-matrix*.md)
      report_path_failure "$tracked_path"
      ;;
  esac

  case "$tracked_path" in
    docs/logo.svg | *.js | *.json | *.lock | *.md | *.rs | *.sh | *.toml | *.ts | *.yaml | *.yml | .gitignore | .prettierignore | LICENSE)
      ;;
    *)
      printf 'public-boundary: unreviewed tracked file type: %s\n' \
        "$tracked_path" >&2
      failed=1
      ;;
  esac
done < <(git ls-files -z)

while IFS= read -r -d '' index_record; do
  index_metadata="${index_record%%$'\t'*}"
  indexed_path="${index_record#*$'\t'}"
  indexed_mode="${index_metadata%% *}"

  if [[ "$indexed_mode" == "120000" ]]; then
    printf 'public-boundary: tracked symlink is not allowed: %s\n' \
      "$indexed_path" >&2
    failed=1
  fi
done < <(git ls-files -s -z)

scan_fixed_pattern() {
  local label="$1"
  local pattern="$2"
  local matches
  local grep_status
  local path_match
  local tracked_path

  matches="$(
    git grep -a -i -n -F -e "$pattern" -- . ":(exclude)$checker_path" 2>/dev/null
  )"
  grep_status=$?

  if [[ $grep_status -eq 0 ]]; then
    printf 'public-boundary: %s found:\n%s\n' "$label" "$matches" >&2
    failed=1
  elif [[ $grep_status -gt 1 ]]; then
    printf 'public-boundary: Git search failed while checking %s\n' "$label" >&2
    exit 2
  fi

  path_match=0
  shopt -s nocasematch
  while IFS= read -r -d '' tracked_path; do
    if [[ "$tracked_path" == *"$pattern"* ]]; then
      printf 'public-boundary: %s found in tracked path: %s\n' \
        "$label" "$tracked_path" >&2
      path_match=1
    fi
  done < <(git ls-files -z)
  shopt -u nocasematch

  if [[ $path_match -eq 1 ]]; then
    failed=1
  fi
}

while IFS=$'\t' read -r label pattern; do
  [[ -n "$label" ]] || continue
  scan_fixed_pattern "$label" "$pattern"
done <<'PATTERNS'
local macOS user path	/Users/
local macOS temporary path	/private/var/folders/
assistant configuration path	.codex/
assistant configuration path	.claude/
plugin URI	plugin://
subagent URI	subagent://
skill URI	skill://
agent URI	agent://
private-vault process language	private project vault
private-vault process language	private vault
local runtime process language	supported local runtimes
local skill process language	shared global skill root
approval workflow language	approval ledger
outreach workflow language	exact recipient, channel, and copy
session workflow language	goal-contract
PATTERNS

private_patterns_file=""
if [[ "${PUBLIC_BOUNDARY_PRIVATE_PATTERNS_FILE+x}" == "x" ]]; then
  private_patterns_file="$PUBLIC_BOUNDARY_PRIVATE_PATTERNS_FILE"
else
  git_common_dir="$(git rev-parse --git-common-dir)"
  if [[ "$git_common_dir" != /* ]]; then
    git_common_dir="$repository_root/$git_common_dir"
  fi

  default_private_patterns_file="$git_common_dir/info/public-boundary-private-patterns"
  if [[ ! -f "$default_private_patterns_file" ]]; then
    # A clone without its patterns file would otherwise pass with the
    # private denylist silently skipped.
    echo "public-boundary: no private patterns file in the git info directory (public-boundary-private-patterns)." >&2
    echo "public-boundary: create it, or set PUBLIC_BOUNDARY_PRIVATE_PATTERNS_FILE= to run without one." >&2
    exit 2
  fi
  private_patterns_file="$default_private_patterns_file"
fi

if [[ -n "$private_patterns_file" ]]; then
  if [[ ! -f "$private_patterns_file" ]]; then
    printf 'public-boundary: private patterns file does not exist: %s\n' \
      "$private_patterns_file" >&2
    exit 2
  fi

  while IFS= read -r private_pattern || [[ -n "$private_pattern" ]]; do
    private_pattern="${private_pattern%$'\r'}"
    [[ "$private_pattern" =~ ^[[:space:]]*$ ]] && continue
    [[ "$private_pattern" =~ ^[[:space:]]*# ]] && continue
    scan_fixed_pattern "private denylist pattern" "$private_pattern"
  done < "$private_patterns_file"
fi

if [[ $failed -ne 0 ]]; then
  echo "public-boundary: failed; move internal-only material outside the public repository" >&2
  exit 1
fi

echo "public-boundary: passed"
