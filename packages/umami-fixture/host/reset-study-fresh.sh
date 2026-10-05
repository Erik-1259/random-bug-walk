#!/bin/sh
# Reset-study candidate (c): a fresh database and an Umami restart for every round. For each
# round it stops the clean stack (dropping its tmpfs database), starts it again, and runs one
# round of the fixture's checks in a throwaway node:24 container on the stack's network, the way
# the protected driver will. It records the wall time of each round, reset included.
#
# Usage: reset-study-fresh.sh <umami dir> <port> <rounds> <out dir>
# <umami dir> is the clean copy from prepare-copy.sh, whose image stack.sh has already built.
# <out dir> must not exist yet; each round writes <out dir>/round-<n>/ and a line to
# <out dir>/timings.tsv (round, exit code, seconds; 1-second resolution).
set -eu

PROJECT=rbw-umami-fixture-clean
NODE_IMAGE=node:24

fail() {
  printf 'reset-study-fresh: %s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 4 ] || {
  printf 'usage: reset-study-fresh.sh <umami dir> <port> <rounds> <out dir>\n' >&2
  exit 2
}
dir=$1
port=$2
rounds=$3
out=$4
case "$rounds" in
  '' | *[!0-9]*) fail "rounds must be a positive integer" ;;
esac
[ ! -e "$out" ] || fail "$out already exists"

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH='' cd -- "$script_dir/../../.." && pwd)
[ -d "$repo/packages/umami-fixture/node_modules/@playwright/test" ] || fail "run pnpm install in $repo first"
mkdir -p "$out"
out=$(CDPATH='' cd -- "$out" && pwd)
UMAMI_TEST_PORT=$port
UMAMI_TEST_IMAGE=rbw-umami-fixture:clean
export UMAMI_TEST_PORT UMAMI_TEST_IMAGE

printf 'round\texit_code\tseconds\n' >"$out/timings.tsv"
i=1
while [ "$i" -le "$rounds" ]; do
  mkdir "$out/round-$i"
  start=$(date +%s)
  (cd "$dir" && docker compose -p "$PROJECT" -f docker-compose.test.yml --profile postgres down -v --remove-orphans)
  (cd "$dir" && docker compose -p "$PROJECT" -f docker-compose.test.yml --profile postgres up --wait)
  set +e
  docker run --rm --network "${PROJECT}_default" \
    -v "$repo:/repo:ro" -v "$out/round-$i:/out" \
    -e RBW_FIXTURE_BASE_URL=http://umami:3000 -e RBW_FIXTURE_REPEAT_INDEX="$i" -e RBW_FIXTURE_OUTPUT_DIR=/out \
    -w /repo "$NODE_IMAGE" \
    node packages/umami-fixture/node_modules/@playwright/test/cli.js test \
    --config packages/umami-fixture/playwright.config.ts --workers=1 --retries=0
  code=$?
  set -e
  end=$(date +%s)
  printf '%s\t%s\t%s\n' "$i" "$code" "$((end - start))" >>"$out/timings.tsv"
  i=$((i + 1))
done
cat "$out/timings.tsv"
