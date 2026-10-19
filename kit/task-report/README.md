# Task-report kit

One container image for copies of the task-report host (the custom task-and-report service in
`hosts/task-report/app`). A copy is one container, or one Sandbox microVM, made from this image
with no network, 4 CPUs and 8 GB. The host places one app source tree (clean, buggy or fixed) in
`/workspace/app` and runs `/opt/rbw/bin/rbw-copy`. There is no Docker or Compose inside: each
instance is a set of processes.

## Layout

| Path | Owner and mode | Content |
| --- | --- | --- |
| `/workspace/app/node_modules` | root, read-only to all | the baseline's dependencies, `npm ci --ignore-scripts` from the vendored lockfile |
| `/workspace/app` (rest) | root, read-only to all | the copy's app tree, placed by the host |
| `/opt/rbw/evaluator` | root only (0700) | the original suite, the evaluator package (`src`, `data`, `protocol`, `baseline`) and its own copy of the dependencies (pg 8.23.1, Playwright 1.63.0) |
| `/opt/rbw/bin` | root, 0755 | `rbw-launch` (the Umami kit's launcher, copied at build time) and `rbw-copy` |
| `/opt/rbw/etc` | root, 0644 | `pg_hba.conf`, the PostgreSQL settings, the environment files and the provisioning SQL |
| `/var/lib/rbw/instances/iNN/pgdata` | rbw-db, 0700 | each instance's fresh database cluster |
| `/var/lib/rbw/results/copy` | root only | the copy's record set, including the captured app and database logs |
| `/run/rbw-pg` | root:rbw-db, 0770 | the database socket; the app user cannot reach it |

The database runs as `rbw-db` (UID 2002) and the app as `rbw-app` (UID 2001), each through
`rbw-launch`: a fixed environment, no new privileges, its own process group, and output captured
by root into files under `/var/lib/rbw/results`. The app connects over loopback TCP as
`taskapp_app` with its password. The evaluator connects through the socket as the superuser (the
monitor), the owner and the gate role.

## One copy

`rbw-copy --state clean|buggy|fixed --run-id f3q-<...> [--purpose smoke ...]` runs
`packages/host-task-report/src/copy/main.ts` with the image's Node:

1. The tree's `package.json` and `package-lock.json` must equal the baseline's, because only the
   baseline's dependencies are installed; otherwise the copy is invalid and nothing else runs.
2. The tree is made root-owned and read-only, then typechecked as `rbw-app`.
3. For each declared instance, one after another: `initdb` of a new cluster, the server,
   `etc/provision/00-roles.sql` as the superuser, the app's own `migrate apply` as the owner,
   `etc/provision/10-after-migrate.sql`, the app (`node src/main.ts`), and its heartbeat. These
   are the instance phases of the prototype harness the service comes from, with processes
   instead of Compose (see `hosts/task-report/SOURCE.md`).
4. On each ready instance: the unchanged original suite once (193 tests, checked against the
   baseline manifest first), then the F3 check blocks and the late re-read, then stop.
5. The record set: `copy.json`, and per instance `lifecycle.json`, `original/`, `checks/` and
   `logs/`.

Both time zones are Asia/Tokyo: app `TZ=Asia/Tokyo` and PostgreSQL `timezone = 'Asia/Tokyo'`
(the comments in `etc/` call this profile M2; see `hosts/task-report/SOURCE.md`). The pool size is
the app's default of 10.

## Host commands

```sh
node packages/host-task-report/src/local/cli.ts build --tag rbw-task-report:<name>
node packages/host-task-report/src/local/cli.ts run --image rbw-task-report:<name> \
  --state clean --run-id f3q-<id> --out <new dir>
node packages/host-task-report/src/local/cli.ts evaluate <copy dir> <copy dir> <copy dir>
```

`run` derives the state's tree from the vendored baseline and the catalog entry on the host, with
every hash checked, and runs the copy with `--network none --cpus 4 --memory 8g`.
