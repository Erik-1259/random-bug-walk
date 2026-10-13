#!/bin/sh
# One local proof copy of the rc-1 fixture in a kit image: optionally plant the RC-1 line,
# build, start, bake the template, then run ROUNDS rounds, each after a template reset and the
# grants the driver restores after one. Runs as root inside the kit image, with this package
# mounted read-only at /rc1 and a writable output directory at /out (the script refuses to start
# if /out/live-<state> is not empty):
#
#   docker run --rm --cpus 4 --memory 6g \
#     -v "<repo>/packages/umami-fixture-rc1:/rc1:ro" -v "<out>:/out" \
#     <kit image> /rc1/host/live-proof.sh clean|planted ROUNDS
#
# Each round's report, observations and evidence land in /out/live-<state>/round-<n>/, and the
# script prints one line per check and round. evidence/live-proof.json summarizes the runs of
# Oct 13, 2026. The planted line is the one the data file's target names.
set -eu
variant=$1
rounds=$2
APP=/workspace/app
ROUTE=$APP/src/app/api/2fa/verify/route.ts
NODE=/opt/rbw/verifier/node/bin/node
FIX=/opt/rbw/verifier/kit/umami-fixture-rc1
OWNER='postgresql://umami_owner@localhost/umami?host=/run/rbw-pg'
OUT=/out/live-$variant
if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT")" ]; then
  echo "refusing: $OUT is not empty; an earlier run's round outputs would be read as this run's. Mount a fresh /out." >&2
  exit 1
fi
mkdir -p "$OUT"

echo "route.ts sha256: $(sha256sum "$ROUTE" | cut -d' ' -f1)"
echo "guarded line count: $(grep -c 'where: { id: unusedCodes\[matchIndex\].id, used: false },' "$ROUTE")"
mkdir -p "$FIX"
for part in package.json playwright.config.ts src checks data; do cp -a "/rc1/$part" "$FIX/$part"; done

if [ "$variant" = planted ]; then
  sed -i 's/where: { id: unusedCodes\[matchIndex\]\.id, used: false },/where: { id: unusedCodes[matchIndex].id },/' "$ROUTE"
  echo "planted line count: $(grep -c 'where: { id: unusedCodes\[matchIndex\].id },' "$ROUTE")"
  echo "planted route.ts sha256: $(sha256sum "$ROUTE" | cut -d' ' -f1)"
fi

/opt/rbw/bin/rbw-build-app > "$OUT/build.log" 2>&1 || { tail -40 "$OUT/build.log"; exit 1; }
tail -3 "$OUT/build.log"
/opt/rbw/bin/rbw-start

cd "$FIX"
$NODE --input-type=module -e "
import { createFixtureTemplate } from '$FIX/src/index.ts';
import pg from 'pg';
await createFixtureTemplate('$OWNER');
const c = new pg.Client({ connectionString: '$OWNER' });
await c.connect();
await c.query('REVOKE ALL ON DATABASE rbw_fixture_template FROM PUBLIC');
await c.end();
console.log('template baked');
"

i=1
while [ "$i" -le "$rounds" ]; do
  $NODE --input-type=module -e "
import { resetFixture } from '$FIX/src/index.ts';
import pg from 'pg';
await resetFixture('$OWNER');
const c = new pg.Client({ connectionString: '$OWNER' });
await c.connect();
await c.query('REVOKE ALL ON DATABASE umami FROM PUBLIC');
await c.query('GRANT CONNECT ON DATABASE umami TO umami_app');
await c.end();
"
  dir="$OUT/round-$i"
  mkdir -p "$dir"
  env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root TMPDIR=/tmp TZ=UTC FORCE_COLOR=0 \
    RBW_FIXTURE_BASE_URL=http://127.0.0.1:3000 RBW_FIXTURE_REPEAT_INDEX="$i" RBW_FIXTURE_OUTPUT_DIR="$dir" \
    RBW_FIXTURE_ADMIN_USERNAME=admin RBW_FIXTURE_ADMIN_PASSWORD=umami \
    $NODE /opt/rbw/verifier/node_modules/@playwright/test/cli.js test --config "$FIX/playwright.config.ts" --workers=1 --retries=0 > "$OUT/round-$i.log" 2>&1 || true
  for obs in "$dir"/observations/*.json; do
    $NODE -e "const o=require('$obs'); let e=null; try { e=require('$dir/'+o.response_artifact_key) } catch {} ; console.log('round $i', o.check_id, o.observed, o.failure_code, e && e.attempts ? e.attempts.map(a=>a.status+(a.error_code?':'+a.error_code:'')+' '+a.sent_ms+'-'+a.settled_ms).join(' | ') : '', e && 'overlap_ms' in e ? 'overlap '+e.overlap_ms : '')"
  done
  i=$((i + 1))
done
cd /
/opt/rbw/bin/rbw-stop || true
