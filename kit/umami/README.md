# Umami kit image

The build definition of one container image for running Umami's API suite against a copy of
Umami. It holds:

- Umami's source at commit `ec0ff50388c264ed8ce46f00967e92f7e71476ae` (MIT), with its locked
  dependencies and build tools;
- PostgreSQL 15 with a migrated `umami` database;
- a protected verifier area: the pristine API-suite closure, the verifier's own locked test
  dependencies and its own Node 24 runtime, with slots for the driver and fixture packages.

The app builds and runs as `rbw-app` (UID 2001) and Postgres runs as `rbw-db` (UID 2002), both
started through `/opt/rbw/bin/rbw-launch`. The image has no browser binaries. This is part of a
hackathon prototype; the driver, the fixture packages and the runner that use the image are
separate work items.

## Files

| Path | Purpose |
|---|---|
| `Dockerfile` | The image. Every base image is pinned by digest; `REGISTRY` selects Docker Hub or a mirror. |
| `bin/rbw-launch` | Runs one command as `rbw-app` or `rbw-db` (see [The launcher](#the-launcher)). |
| `bin/rbw-build-app` | Cold build of the app as `rbw-app`, timed against the 240 s budget. |
| `bin/rbw-start`, `bin/rbw-stop` | Start Postgres and Umami and wait for the heartbeat; stop both. |
| `bin/rbw-db-init` | Creates and migrates the database at image build time. |
| `bin/rbw-kit-selftest` | In-image checks of isolation and contents. |
| `bin/rbw-check-cold`, `bin/rbw-listening` | Helpers: leftover build outputs and caches; listening sockets. |
| `etc/` | Environment files, Postgres settings, `pg_hba.conf`, role and grant SQL. |
| `build-outputs.txt` | The paths `pnpm build:docker` writes, the only ones `rbw-app` may write in the app tree. |
| `closure.sha256` | SHA-256 of each file in the API-suite closure. |
| `fonts/` | The mocked Google Fonts response and the font files' hashes, for the offline build. |
| `verifier/` | The verifier's `package.json` and pnpm lockfile. |
| `src/manifest.ts` | Writes the image manifest at build time. |
| `test/` | Static tests (Vitest). |

## Base images

Each digest is the multi-architecture index digest, so Docker pulls the native arm64 or amd64
image without emulation.

| Tag | Digest | Contents |
|---|---|---|
| `node:22-alpine` | `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402` | Node 22.23.3, Alpine 3.24.2 (the app runtime and the final image) |
| `node:24-alpine` | `sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1` | Node 24.21.0 (only its `node` binary, copied to the verifier) |
| `postgres:15-alpine` | `sha256:f7d23353e1b15400d22ebe31189f4d314b87a4c129cc400c8c2d8d4ca127bf81` | PostgreSQL 15.19, Alpine 3.24.2 |

The digests were read on 2026-10-05 from Docker Hub's tag API
(`https://hub.docker.com/v2/repositories/library/<repo>/tags/<tag>`, field `digest`) and
cross-checked against the `Docker-Content-Digest` header of the registry's manifest API
(`https://registry-1.docker.io/v2/library/<repo>/manifests/<tag>`, with an anonymous pull
token). The versions come from each image's configuration (`NODE_VERSION`, `PG_VERSION`) and
history (`alpine-minirootfs-3.24.2`).

Alpine 3.24 has no `postgresql15` package, so the Postgres binaries, libraries and share files
are copied from the official `postgres:15-alpine` image, which is built on the same Alpine
release. Its shared-library dependencies are installed from Alpine by soname, as the official
image does. JIT and the Perl, Python and Tcl languages are left out; `jit = off`.

`tzdata`, `tini`, `setpriv`, `tmux`, `curl`, `busybox-extras`, `icu-data-full` and
`libc6-compat` come from Alpine 3.24. Alpine package versions are not pinned, because Alpine
removes superseded versions from its repositories; the manifest records every installed package
and version, including `tzdata` (2026d-r0 when this was written), which is Postgres's time zone
data.

pnpm 12.3.4 builds the app, as Umami pins it. pnpm 10.33.2 installs the verifier lockfile in a
build stage and is not shipped.

## Layout

| Path | Owner and mode | Purpose |
|---|---|---|
| `/workspace/app` | root, read-only to `rbw-app`, except the build outputs below | Umami at the pinned commit, plus `src/proxy.ts` |
| `/workspace/app/node_modules`, `packages/*/node_modules` | root, read-only to `rbw-app` | Umami's locked dependencies |
| `/opt/rbw/bin/` | root, 0755 | The launcher, the start, stop and build scripts, the self-test |
| `/opt/rbw/etc/` | root, 0755, files 0644 | Environment files, Postgres settings, SQL, `build-outputs.txt` |
| `/opt/rbw/build/` | root, 0755, files 0644 | The mocked font stylesheet and the font files |
| `/opt/rbw/verifier/` | root; directories 0700, files 0600, executables 0700 | `suite/`, `node_modules/`, `node/bin/node`, `kit/`, `package.json`, `pnpm-lock.yaml`, `closure.sha256`, `app-tracked.sha256`, `image-manifest.json` |
| `/var/lib/rbw/results/` | root, 0700 | Trial outputs |
| `/var/lib/rbw/logs/` | root, 0700 | Build, Postgres and Umami logs |
| `/var/lib/rbw/pgdata` | `rbw-db`, 0700 | The database cluster, migrated at build time |
| `/run/rbw/` | root, 0700 | PID files of the running launchers |
| `/run/rbw-pg/` | root:`rbw-db`, 0770 | Postgres's Unix socket |
| `/var/tmp/rbw-app`, `/var/tmp/rbw-db` | the user, 0700 | `HOME` and `TMPDIR` of each user |

`/tmp` and `/var/tmp` are root-owned 0755, so neither user can write there. The image has no
setuid or setgid files; `su` is a busybox applet without the setuid bit, and there is no `sudo`
or `doas`. Docker's own `/dev/shm` and `/dev/mqueue` mounts stay writable by every user.

### Build outputs

`pnpm build:docker` writes exactly the paths in `build-outputs.txt`. In the image they are empty
and owned by `rbw-app`:

- directories: `.next`, `generated`, `src/generated`, `packages/api-client/dist`,
  `packages/mcp/dist`;
- files: `next-env.d.ts`, `public/script.js`, `public/recorder.js`, `public/openapi.json`;
- tracked files that the build regenerates with the same content, so they keep their content
  and become writable: `src/tracker/index.d.ts`,
  `packages/api-client/src/generated/types.ts`,
  `packages/api-client/src/generated/operations.ts`;
- `packages/api-client` and `packages/mcp`, which become root:`rbw-app` 1775 (sticky), because
  tsup writes and deletes a `tsup.config.bundled_*.mjs` next to each package's config. The
  sticky bit lets `rbw-app` add and remove its own files there but not change or remove the
  tracked ones.

The list was found by running the build with the whole tree read-only except these paths. The
image ships no `.next`, no Next or turbo cache, no app source maps and no pnpm store;
`rbw-check-cold` checks this, and `rbw-build-app` refuses to start otherwise.

### Tracked Umami files

No tracked Umami file is modified. Umami's Dockerfile appends `strictDepBuilds: false` to
`pnpm-workspace.yaml` before installing; here the install stage sets the environment variable
`pnpm_config_strict_dep_builds=false` instead, which pnpm 12 reads as that setting. The frozen
install also succeeds without it.

Like Umami's builder stage, the image copies `docker/proxy.ts` to `src/proxy.ts`, which is not a
tracked file, so the Next proxy (middleware) is part of the build. The manifest records it as a
build input with its hash. Run against the same database setup, builds with and without it gave
the same API-suite result.

The source stage records the SHA-256 of every tracked file at the pinned commit in
`/opt/rbw/verifier/app-tracked.sha256`; the self-test checks the app copy against it.

### Offline build

Umami's root layout loads the Inter font through `next/font/google`, which Next downloads at
build time, so a build without network fails. `rbw-build-app` sets
`NEXT_FONT_GOOGLE_MOCKED_RESPONSES` (a Next setting used by its own tests) to
`/opt/rbw/build/next-font-google-mocks.cjs`, which holds the stylesheet that Google Fonts
returns to Next, with the font URLs pointing at `http://127.0.0.1:3901/`. For the duration of
the build, a busybox httpd running as `rbw-app` serves the font files there. The image build
downloads the files from `fonts.gstatic.com` and checks them against `fonts/fonts.sha256`, so
the build output contains the same fonts as an online build.

## The launcher

```
rbw-launch --as app|db [--cwd <dir>] [--stdout <file>] [--stderr <file>] [--max-stream-bytes <n>] [--timeout-ms <n>] [--env-file <file>] -- <command> [args...]
```

A POSIX `sh` script, run as root, around `setsid`, `setpriv` (util-linux) and `env -i`:

- It sets the UID and GID of `rbw-app` (2001) or `rbw-db` (2002), clears supplementary groups
  and inheritable capabilities, and sets no-new-privileges.
- The environment starts empty, then gets `PATH=/usr/local/bin:/usr/bin:/bin`, `HOME`, `TMPDIR`
  and `TMUX_TMPDIR` (the user's `/var/tmp` directory), `USER`, `LOGNAME`, `SHELL=/bin/sh` and
  `LANG=C.UTF-8`, then the env file. An env file has `KEY=VALUE` lines (the value is taken
  literally, without quoting), `unset KEY` lines, comments and blank lines. The env file can
  never set `LD_*`, `NODE_OPTIONS`, `NODE_PATH` or similar loader and interpreter overrides, nor
  the fixed keys above.
- The command runs in a new session and process group, with stdin from `/dev/null`.
- Each stream keeps its first `--max-stream-bytes` bytes (default 1 MiB); the rest is drained,
  and the file ends with `[rbw-launch: output truncated at <n> bytes]`. Without `--stdout` or
  `--stderr`, the capped stream is copied to the launcher's own stream when the command ends.
- On timeout, or on TERM or INT to the launcher, the group gets TERM, then KILL after 5 s, and
  the launcher waits until no process is left in the group. Processes the command leaves in its
  group are stopped the same way when it exits.
- Exit status: the command's status; 124 after a timeout; 143 after TERM; 130 after INT; 125 for
  a usage or launch error, or a group that did not end.

The launcher never runs package lifecycle scripts. At image build, the verifier's install runs
with `--ignore-scripts`, while the app's frozen install runs only the install scripts that the pinned
Umami workspace configuration approves (`prisma` and `@prisma/engines`). Package installs happen in
build stages as the unprivileged `node` user, never as root.

## Database

Postgres listens on `127.0.0.1:5432` and on the socket in `/run/rbw-pg`, which only root and
`rbw-db` can reach.

| Role | Rights | Login |
|---|---|---|
| `postgres` | bootstrap superuser | socket only |
| `umami_owner` | owns the `umami` database and schema; runs migrations and fixture resets | socket only, no password: `postgresql://umami_owner@localhost/umami?host=/run/rbw-pg` |
| `umami_app` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` on tables and use of sequences; read-only on `_prisma_migrations`; no superuser, role or database creation | TCP from 127.0.0.1 with its password, as in `etc/app.environment` |

The migrations are applied as `umami_owner` when the image is built. At start, `rbw-start` runs
Umami's `scripts/check-db.js` as `rbw-app` with the restricted role, as Umami's
`start-docker.sh` does; with nothing to apply, it succeeds without owner rights.

## Environment

`etc/app.environment` holds the app's settings: `TZ=UTC`, `DISABLE_BOT_CHECK=1`,
`MCP_ENABLED=1`, `DISABLE_TELEMETRY=1`, `DISABLE_UPDATES=1`, `NEXT_TELEMETRY_DISABLED=1`, the
public test value of `APP_SECRET` from Umami's `docker-compose.test.yml`, a
`TWO_FACTOR_ENCRYPTION_KEY` of 64 zeros (Umami accepts any 64 hex digits; the compose file's
value trips the secret scanner's generic-key rule), `DATABASE_URL` for `umami_app` on loopback,
`HOSTNAME`, `PORT` and
`NODE_ENV` for the standalone server, and `CHECKPOINT_DISABLE=1` for Prisma. It unsets
`CLICKHOUSE_URL`, `REDIS_URL`, `CLOUD_MODE` and `DATABASE_REPLICA_URL`. `etc/build.environment`
matches the builder stage of Umami's Dockerfile, with `SKIP_BUILD_GEO=1`. All values are
synthetic.

## Image manifest

`/opt/rbw/verifier/image-manifest.json` (root, 0600) records the base image digests; the Node,
pnpm, Postgres, Alpine and `tzdata` versions; every installed Alpine package; the Umami commit;
the SHA-256 of Umami's `pnpm-lock.yaml`, of the verifier lockfile, of the tracked-file list and
of each suite closure file; the build inputs (`src/proxy.ts`, the font stylesheet and files);
both environment files; and the build outputs. It has no timestamps, so the same inputs give the
same bytes. The image digest is recorded outside the image, after the build.

## Host commands

Run from the repository root on a host with Docker. Replace `<tag>` with an image tag and
`<dir>` with a directory holding the driver and fixture packages.

```sh
docker build --build-arg REGISTRY=docker.io -t <tag> kit/umami
docker build --build-arg REGISTRY=docker.io --build-context rbw-kit=<dir> -t <tag> kit/umami
docker image inspect -f '{{.Size}}' <tag>
docker run --rm --network none --cpus 4 --memory 8g --security-opt no-new-privileges <tag> /opt/rbw/bin/rbw-build-app
docker run --rm --network none --cpus 4 --memory 8g --security-opt no-new-privileges <tag> sh -c '/opt/rbw/bin/rbw-build-app > /dev/null && /opt/rbw/bin/rbw-start; status=$?; /opt/rbw/bin/rbw-stop; exit $status'
docker run --rm --network none --security-opt no-new-privileges <tag> /opt/rbw/bin/rbw-kit-selftest
docker run --rm --network none <tag> /opt/rbw/bin/rbw-kit-selftest
docker run --rm --network none --security-opt no-new-privileges <tag> sh -c 'chmod -R go+rX /opt/rbw/verifier; /opt/rbw/bin/rbw-kit-selftest'
```

With `--security-opt no-new-privileges`, every process in the container already has
`NoNewPrivs: 1`, so `launcher-sets-no-new-privs` cannot show that the launcher sets it, and the
self-test prints a note saying so. The second self-test command, without that option, tests the
launcher's own setting.

The last command is a revert run: with the verifier tree readable by others, the self-test
reports `fail app-cannot-read-verifier`, `fail app-cannot-list-verifier` and
`fail verifier-tree-is-root-only`, and exits 1.

## Tests

```sh
pnpm exec vitest run --root kit/umami
```

The static tests check the Dockerfile, the scripts and the committed lists. The in-image checks
are in `bin/rbw-kit-selftest`.

## What it does not do

- It does not apply source patches, audit the source projection, or run the API suite; the
  driver and the runner do that.
- It has no browsers, so browser-based tests cannot run in it.
- It does not pin Alpine package versions; the manifest records them.
- It does not restrict Docker's `/dev/shm` and `/dev/mqueue` mounts.
