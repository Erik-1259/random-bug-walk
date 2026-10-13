#!/bin/sh
# Prepares a working copy of Umami at the pinned commit in one code state for the
# umami-tz-arg-001 proof runs: clean, planted, partial or stub.
#
# These edits are proof scaffolding. They exist only to show that the fixture's checks tell
# the states apart. The canonical rule and probe data belong to another package (item W1-6),
# and this script will switch to that data once it merges.
#
# Usage: prepare-copy.sh <clean|planted|partial|stub> <dir>
# <dir> must not exist yet. Exits non-zero, changing nothing further, if the pinned file
# differs from the expected bytes or an edit does not produce exactly one changed hunk.
set -eu

REPOSITORY=https://github.com/umami-software/umami.git
COMMIT=ec0ff50388c264ed8ce46f00967e92f7e71476ae
TARGET=src/queries/sql/pageviews/getPageviewStats.ts
TARGET_SHA256=1f679f7a666f2ca7888b9094fb85a69a31b546566f194e27ac6eef2e9aef9b1b

DESTRUCTURE_LINE=17
DESTRUCTURE_TEXT="  const { timezone = 'utc', unit = 'day' } = filters;"
BUCKET_LINE=28
BUCKET_TEXT="      \${getDateSQL('website_event.created_at', unit, timezone)} x,"

fail() {
  printf 'prepare-copy: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'usage: prepare-copy.sh <clean|planted|partial|stub> <dir>\n' >&2
  exit 2
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

# Prints line $2 of file $1.
line_of() {
  sed -n "${2}p" "$1"
}

# Replaces line $2 of file $1 with the text $3.
replace_line() {
  EDIT_TEXT=$3 awk -v n="$2" 'NR == n { print ENVIRON["EDIT_TEXT"]; next } { print }' "$1" >"$1.edit"
  mv "$1.edit" "$1"
}

# Inserts the text $3 as a new line directly after line $2 of file $1.
insert_after() {
  EDIT_TEXT=$3 awk -v n="$2" '{ print } NR == n { print ENVIRON["EDIT_TEXT"] }' "$1" >"$1.edit"
  mv "$1.edit" "$1"
}

[ "$#" -eq 2 ] || usage
state=$1
dir=$2
case "$state" in
  clean | planted | partial | stub) ;;
  *) usage ;;
esac
[ ! -e "$dir" ] || fail "$dir already exists"

git clone --quiet --no-checkout "$REPOSITORY" "$dir"
git -C "$dir" -c advice.detachedHead=false checkout --quiet "$COMMIT"
[ "$(git -C "$dir" rev-parse HEAD)" = "$COMMIT" ] || fail "checkout is not at $COMMIT"

file="$dir/$TARGET"
[ "$(sha256_of "$file")" = "$TARGET_SHA256" ] || fail "$TARGET does not have the pinned SHA-256"
[ "$(line_of "$file" "$DESTRUCTURE_LINE")" = "$DESTRUCTURE_TEXT" ] || fail "unexpected text on line $DESTRUCTURE_LINE"
[ "$(line_of "$file" "$BUCKET_LINE")" = "$BUCKET_TEXT" ] || fail "unexpected text on line $BUCKET_LINE"

case "$state" in
  clean)
    printf 'clean %s %s\n' "$TARGET" "$(sha256_of "$file")"
    exit 0
    ;;
  planted)
    replace_line "$file" "$BUCKET_LINE" \
      "      \${getDateSQL('website_event.created_at', unit)} x,"
    expected_numstat="1	1	$TARGET"
    ;;
  partial)
    replace_line "$file" "$BUCKET_LINE" \
      "      \${getDateSQL('website_event.created_at', unit, timezone === 'Pacific/Auckland' ? timezone : 'UTC')} x,"
    expected_numstat="1	1	$TARGET"
    ;;
  stub)
    insert_after "$file" "$DESTRUCTURE_LINE" \
      "  if (timezone.toLowerCase() !== 'utc') return [{ x: '2026-03-08T00:00:00Z', y: 12 }];"
    expected_numstat="1	0	$TARGET"
    ;;
esac

[ "$(git -C "$dir" status --porcelain)" = " M $TARGET" ] || fail "the edit changed more than $TARGET"
[ "$(git -C "$dir" diff --numstat)" = "$expected_numstat" ] || fail "the edit is not exactly one changed line in $TARGET"
hunks=$(git -C "$dir" diff -U0 | grep -c '^@@')
[ "$hunks" -eq 1 ] || fail "the edit produced $hunks hunks, not 1"

git -C "$dir" diff -U0
printf '%s %s %s\n' "$state" "$TARGET" "$(sha256_of "$file")"
