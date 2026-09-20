#!/usr/bin/env bash

set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
checker_source="$repository_root/scripts/check-public-boundary.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/hedwig-public-boundary.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

case_number=0
case_repository=""

new_case_repository() {
  case_number=$((case_number + 1))
  case_repository="$test_root/case-$case_number"

  mkdir -p "$case_repository/scripts"
  cp "$checker_source" "$case_repository/scripts/check-public-boundary.sh"
  chmod +x "$case_repository/scripts/check-public-boundary.sh"
  printf '# Boundary fixture\n' > "$case_repository/README.md"

  git -C "$case_repository" init --quiet
  git -C "$case_repository" add README.md scripts/check-public-boundary.sh
}

add_text_file() {
  local relative_path="$1"
  local content="${2:-fixture}"

  mkdir -p "$case_repository/$(dirname "$relative_path")"
  printf '%s\n' "$content" > "$case_repository/$relative_path"
  git -C "$case_repository" add "$relative_path"
}

expect_pass() {
  local label="$1"

  if ! (
    cd "$case_repository"
    PUBLIC_BOUNDARY_PRIVATE_PATTERNS_FILE="" \
      bash scripts/check-public-boundary.sh >/dev/null
  ); then
    printf 'public-boundary-test: expected pass: %s\n' "$label" >&2
    exit 1
  fi
}

expect_fail() {
  local label="$1"

  if (
    cd "$case_repository"
    PUBLIC_BOUNDARY_PRIVATE_PATTERNS_FILE="" \
      bash scripts/check-public-boundary.sh >/dev/null 2>&1
  ); then
    printf 'public-boundary-test: expected failure: %s\n' "$label" >&2
    exit 1
  fi
}

new_case_repository
add_text_file ".github/pull_request_template.md"
add_text_file ".github/workflows/ci.yml" "name: fixture"
add_text_file ".cargo/config.toml"
add_text_file ".devcontainer/devcontainer.json" "{}"
add_text_file ".vscode/settings.json" "{}"
expect_pass "approved public configuration files"

new_case_repository
add_text_file "evals/runner.js" "'use strict';"
expect_pass "public JavaScript eval runner"

new_case_repository
add_text_file "docs/logo.svg" '<svg xmlns="http://www.w3.org/2000/svg"/>'
expect_pass "reviewed logo path"

new_case_repository
add_text_file "docs/other.svg" '<svg xmlns="http://www.w3.org/2000/svg"/>'
expect_fail "unreviewed SVG path"

for rejected_path in \
  "docs/.workspace/private.md" \
  ".github/workflows/internal/private.yml" \
  ".github/workflows/.private.yml" \
  ".cargo/.private.toml" \
  ".devcontainer/.private.json" \
  ".vscode/.private.json"; do
  new_case_repository
  add_text_file "$rejected_path"
  expect_fail "$rejected_path"
done

new_case_repository
add_text_file "artifact.png"
expect_fail "unreviewed file type"

new_case_repository
ln -s README.md "$case_repository/linked.md"
git -C "$case_repository" add linked.md
expect_fail "tracked symlink"

new_case_repository
mkdir -p "$case_repository/.git/info" "$case_repository/docs"
printf 'RESTRICTED-TERM\n' > "$case_repository/.git/info/patterns"
printf 'fixture\n' > "$case_repository/docs/restricted-term.md"
git -C "$case_repository" add docs/restricted-term.md
if (
  cd "$case_repository"
  PUBLIC_BOUNDARY_PRIVATE_PATTERNS_FILE="$case_repository/.git/info/patterns" \
    bash scripts/check-public-boundary.sh >/dev/null 2>&1
); then
  echo "public-boundary-test: expected private filename failure" >&2
  exit 1
fi

new_case_repository
mkdir -p "$case_repository/.git/info"
printf 'RESTRICTED-TERM\n' > "$case_repository/.git/info/patterns"
printf '\000restricted-term\000' > "$case_repository/evidence.md"
git -C "$case_repository" add evidence.md
if (
  cd "$case_repository"
  PUBLIC_BOUNDARY_PRIVATE_PATTERNS_FILE="$case_repository/.git/info/patterns" \
    bash scripts/check-public-boundary.sh >/dev/null 2>&1
); then
  echo "public-boundary-test: expected binary-content failure" >&2
  exit 1
fi

echo "public-boundary-test: passed"
