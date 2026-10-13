#!/bin/sh
# The rc-1 race flakiness/delay study. One copy of the fixture in a race kit image (kit/umami-race,
# a time-zone kit with Toxiproxy between Umami and Postgres): optionally plant the RC-1 line, build,
# start, bake the template, then sweep a list of database delays. At each delay it sets the proxy's
# latency toxic once with "rbw-proxy set-latency", checks the proxy once then and after each round, and runs
# ROUNDS rounds, each after a template reset. The concurrent double-spend check and the serial
# control run in one Playwright run per round.
#
# Runs as root inside the race kit image, with this package mounted read-only at /rc1 and a writable
# output directory at /out (the script refuses to start if /out/study-<variant> is not empty):
#
#   docker run --rm --cpus 4 --memory 6g \
#     -v "<repo>/packages/umami-fixture-rc1:/rc1:ro" -v "<out>:/out" \
#     <race kit image> /rc1/host/race-delay-study.sh clean|planted ROUNDS "DELAY_MS ..."
#
# The third argument is a space-separated list of whole-millisecond delays (default "0 25 50 100 200").
# For each delay the script writes one JSON line per check per round to /out/study-<variant>/rounds.jsonl
# with the delay, round index, check id, observed outcome, failure code, the two verify attempts
# (status, error code, token issued, sent/settled ms), the overlap, and the check's duration (round
# time), and it prints a one-line summary per check per delay. The planted line is the one the data
# file's target names. A round that does not leave an observation for every check the data file
# names (a Playwright timeout or abort) stops the study with an error, so a sweep never reports
# fewer rounds than it was asked for. evidence/rc-1-race-study.json summarizes a run of this script.
set -eu
variant=$1
rounds=$2
delays=${3:-"0 25 50 100 200"}
APP=/workspace/app
ROUTE=$APP/src/app/api/2fa/verify/route.ts
NODE=/opt/rbw/verifier/node/bin/node
FIX=/opt/rbw/verifier/kit/umami-fixture-rc1
OWNER='postgresql://umami_owner@localhost/umami?host=/run/rbw-pg'
OUT=/out/study-$variant
if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT")" ]; then
  echo "refusing: $OUT is not empty; an earlier run's round outputs would be read as this run's. Mount a fresh /out." >&2
  exit 1
fi
mkdir -p "$OUT"
JSONL=$OUT/rounds.jsonl
: > "$JSONL"

echo "variant: $variant  rounds-per-delay: $rounds  delays: $delays"
echo "arch: $(uname -m)"
echo "route.ts sha256: $(sha256sum "$ROUTE" | cut -d' ' -f1)"
mkdir -p "$FIX"
for part in package.json playwright.config.ts src checks data; do cp -a "/rc1/$part" "$FIX/$part"; done
CHECKS=$($NODE -e "console.log(require('$FIX/data/rc-1-backup-code-001.v1.json').checks.map(c=>c.check_id).join(' '))")

if [ "$variant" = planted ]; then
  sed -i 's/where: { id: unusedCodes\[matchIndex\]\.id, used: false },/where: { id: unusedCodes[matchIndex].id },/' "$ROUTE"
  echo "planted line count: $(grep -c 'where: { id: unusedCodes\[matchIndex\].id },' "$ROUTE")"
  echo "planted route.ts sha256: $(sha256sum "$ROUTE" | cut -d' ' -f1)"
fi

/opt/rbw/bin/rbw-build-app > "$OUT/build.log" 2>&1 || { tail -40 "$OUT/build.log"; exit 1; }
tail -1 "$OUT/build.log"
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

for delay in $delays; do
  /opt/rbw/bin/rbw-proxy set-latency "$delay" > /dev/null
  before=$(/opt/rbw/bin/rbw-proxy check) || { echo "proxy check failed before delay=$delay"; exit 1; }
  echo "===== delay=${delay}ms ($before) ====="
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
    dir="$OUT/d${delay}-round-$i"
    mkdir -p "$dir"
    env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root TMPDIR=/tmp TZ=UTC FORCE_COLOR=0 \
      RBW_FIXTURE_BASE_URL=http://127.0.0.1:3000 RBW_FIXTURE_REPEAT_INDEX="$i" RBW_FIXTURE_OUTPUT_DIR="$dir" \
      RBW_FIXTURE_ADMIN_USERNAME=admin RBW_FIXTURE_ADMIN_PASSWORD=umami \
      $NODE /opt/rbw/verifier/node_modules/@playwright/test/cli.js test --config "$FIX/playwright.config.ts" --workers=1 --retries=0 > "$OUT/d${delay}-round-$i.log" 2>&1 || true
    /opt/rbw/bin/rbw-proxy check > /dev/null || { echo "proxy check failed after delay=$delay round=$i"; exit 1; }
    for check in $CHECKS; do
      [ -f "$dir/observations/$check.json" ] || { echo "delay $delay round $i: no observation for $check (see $OUT/d${delay}-round-$i.log)" >&2; exit 1; }
    done
    for check in $CHECKS; do
      obs="$dir/observations/$check.json"
      $NODE -e "
const fs=require('fs');
const o=JSON.parse(fs.readFileSync('$obs','utf8'));
let e=null; try { e=JSON.parse(fs.readFileSync('$dir/'+o.response_artifact_key,'utf8')); } catch {}
const rec={ delay_ms:$delay, variant:'$variant', round:$i, check_id:o.check_id, observed:o.observed, failure_code:o.failure_code, duration_ms:o.duration_ms };
if (e && e.attempts) rec.attempts=e.attempts.map(a=>({status:a.status,error_code:a.error_code,token_issued:a.token_issued,sent_ms:a.sent_ms,settled_ms:a.settled_ms}));
if (e && 'overlap_ms' in e) rec.overlap_ms=e.overlap_ms;
fs.appendFileSync('$JSONL', JSON.stringify(rec)+'\n');
const att=rec.attempts?rec.attempts.map(a=>a.status+(a.error_code?':'+a.error_code:'')+(a.token_issued?' T':'')).join(' | '):'';
console.log('delay '+$delay+' round $i '+o.check_id+' '+o.observed+(o.failure_code?':'+o.failure_code:'')+' '+Math.round(o.duration_ms)+'ms'+(('overlap_ms' in (e||{}))?' overlap '+e.overlap_ms:'')+'  '+att);
"
    done
    i=$((i + 1))
  done
done
cd /
/opt/rbw/bin/rbw-stop || true
echo "rounds.jsonl: $JSONL"
