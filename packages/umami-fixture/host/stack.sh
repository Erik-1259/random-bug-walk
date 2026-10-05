#!/bin/sh
# Starts or stops the pinned Umami test stack (docker-compose.test.yml, Postgres profile) for a
# working copy made by prepare-copy.sh. Each state gets its own compose project and image tag.
# Only one fixture stack may run at a time.
#
# Usage: stack.sh <up|down> <clean|planted|partial|stub> <dir> <port>
# With RBW_FIXTURE_DB_PORT set, "up" also applies compose.db-port.yml, which publishes Postgres
# on host loopback at that port (used only for the reset study).
set -eu

PROJECT_PREFIX=rbw-umami-fixture

fail() {
  printf 'stack: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'usage: stack.sh <up|down> <clean|planted|partial|stub> <dir> <port>\n' >&2
  exit 2
}

[ "$#" -eq 4 ] || usage
action=$1
state=$2
dir=$3
port=$4
case "$action" in
  up | down) ;;
  *) usage ;;
esac
case "$state" in
  clean | planted | partial | stub) ;;
  *) usage ;;
esac
case "$port" in
  '' | *[!0-9]*) usage ;;
esac
[ -f "$dir/docker-compose.test.yml" ] || fail "$dir has no docker-compose.test.yml"

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
project="$PROJECT_PREFIX-$state"
UMAMI_TEST_PORT=$port
UMAMI_TEST_IMAGE="$PROJECT_PREFIX:$state"
export UMAMI_TEST_PORT UMAMI_TEST_IMAGE

cd "$dir"
if [ "$action" = down ]; then
  docker compose -p "$project" -f docker-compose.test.yml --profile postgres down -v --remove-orphans
  exit 0
fi

running=$(docker compose ls --quiet --filter "name=$PROJECT_PREFIX-")
for other in $running; do
  [ "$other" = "$project" ] || fail "stack $other is running; stop it first"
done

if [ -n "${RBW_FIXTURE_DB_PORT:-}" ]; then
  docker compose -p "$project" -f docker-compose.test.yml -f "$script_dir/compose.db-port.yml" \
    --profile postgres up --build --wait
else
  docker compose -p "$project" -f docker-compose.test.yml --profile postgres up --build --wait
fi
