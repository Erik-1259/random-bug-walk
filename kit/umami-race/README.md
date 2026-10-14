# Umami race kit image

The build definition of the kit image for the race bug family: the time-zone kit image
(`kit/umami`) with [Toxiproxy](https://github.com/Shopify/toxiproxy) (MIT) between Umami and
Postgres, so every reply from the database to the app can carry a fixed delay. This is part of a
hackathon prototype.

It is an overlay. The base is a finished `kit/umami` image, passed in as a build context, and this
Dockerfile only adds layers on top. Nothing in `kit/umami` changes, so the time-zone image, its
build inputs and its digest stay as they are; every layer of the base image is also a layer of the
race image.

## Files

| Path | Purpose |
|---|---|
| `Dockerfile` | The overlay. Its one registry image (`node:22-alpine`, the same digest as `kit/umami`) only downloads and checks the Toxiproxy binary. |
| `toxiproxy.sha256` | SHA-256 of `toxiproxy-server` v2.12.0 for Linux amd64 and arm64. |
| `bin/rbw-proxy` | Starts, checks, sets the latency of and stops Toxiproxy. |
| `src/proxy-check.ts` | `rbw-proxy`'s parsing, state comparison and API log audit; shipped in the image. |
| `bin/rbw-start`, `bin/rbw-stop` | Wrap the base scripts: Postgres, then the proxy, then Umami; stop all three. |
| `bin/rbw-kit-selftest`, `bin/rbw-race-selftest` | The base self-test, then the race checks. |
| `etc/app.environment` | The base app environment with `DATABASE_URL` on port 5433. |
| `src/race-manifest.ts` | Writes the race image manifest at build time. |
| `test/` | Static tests (Vitest). |

## What the overlay changes

| Path in the image | Change |
|---|---|
| `/usr/local/bin/toxiproxy-server` | Added: the static binary for the target architecture, checked against `toxiproxy.sha256` before it is installed. |
| `/opt/rbw/bin/rbw-start`, `rbw-stop`, `rbw-kit-selftest` | The base scripts are kept as `rbw-start-base`, `rbw-stop-base` and `rbw-kit-selftest-base`; the race scripts take their names. |
| `/opt/rbw/bin/rbw-proxy`, `rbw-race-selftest` | Added. |
| `/opt/rbw/etc/app.environment` | Replaced: `DATABASE_URL` points at `127.0.0.1:5433`. Every other line is the base file's. |
| `/opt/rbw/etc/race.environment` | Added: `RBW_RACE_LATENCY_MS`, from the build argument `RACE_LATENCY_MS`. |
| `/opt/rbw/verifier/image-manifest.json` | Replaced by the race manifest; the base manifest moves to `base-image-manifest.json`. |
| `/opt/rbw/verifier/toxiproxy.sha256` | Added (root, 0600). |
| `/opt/rbw/verifier/rbw-proxy-check.ts` | Added (root, 0600): `src/proxy-check.ts`. |

The driver and the local runner call `rbw-start`, `rbw-stop` and `rbw-kit-selftest` by their usual
paths. The driver also finds `rbw-proxy` on this image and runs Umami's original suite at 0 ms,
then puts the race latency back with `rbw-proxy set-latency` before the added checks' rounds (see
[Latency](#latency)).

## The proxy

| What | Where |
|---|---|
| Postgres | `127.0.0.1:5432`, unchanged |
| Toxiproxy API | `127.0.0.1:8474` |
| Proxy `postgres` | listens on `127.0.0.1:5433`, forwards to `127.0.0.1:5432` |
| Toxic `latency_downstream` | type `latency`, stream `downstream` (Postgres to Umami), toxicity 1, jitter 0, latency `RBW_RACE_LATENCY_MS` |

`toxiproxy-server` runs as `rbw-db` through `rbw-launch`, with `-seed 1`; its log goes to
`/var/lib/rbw/toxiproxy/api.log` and its standard error to `/var/lib/rbw/logs/toxiproxy.stderr.log`. `rbw-start` runs the base
script with `--db-only`, then `rbw-proxy start`, then the base script again, which finds Postgres
running and starts Umami; that second call's `ready_ms` does not include the proxy's start-up.
`rbw-start --db-only` starts Postgres and the proxy. `rbw-stop` runs the base stop, then stops the
proxy.

`rbw-proxy` commands, all run as root:

| Command | What it does |
|---|---|
| `start` | Starts the server, creates the proxy, replaces the toxic with one at the latency in effect, marks the API log, then runs `check`. |
| `check` | Exits 0 only when the API reports exactly one proxy and exactly one toxic, both as configured, at the latency in effect, **and** the API log has no request other than a `GET` since the last `start` or `set-latency`. Prints `proxy_checked latency_ms=<ms>`. |
| `set-latency <ms>` | Sets this container's latency, a whole number from 0 to 10000, in place of the image default. Applies it at once when the proxy runs, then runs `check`. The value lives in `/run/rbw/race-latency.environment`, which only root can write. `set-latency default` removes it. |
| `latency` | Prints `proxy_latency latency_ms=<ms> source=default\|override`. |
| `stop` | Stops the server. |

The parsing, the comparison and the log audit are in `src/proxy-check.ts`, which the image ships
as `/opt/rbw/verifier/rbw-proxy-check.ts` (root, 0600) and runs with the verifier's Node.

### Latency

The image default comes from the build argument `RACE_LATENCY_MS` (default 0 ms), and the manifest
records it. One image serves every delay setting: root changes the latency per container, or
between rounds in one container, with `rbw-proxy set-latency <ms>`, so a sweep over 20 or more
settings, or a check of a fix under each of them, runs against the one image digest that admission
and the release record. A caller that sets a latency records, for each round, the
`rbw-proxy latency` line and the `rbw-proxy check` results from before and after the round.

In a trial, the driver (`packages/umami-driver`, README, "The race kit's database latency") reads
`rbw-proxy latency` after `rbw-start`, runs `rbw-proxy set-latency 0` for Umami's original suite,
then `rbw-proxy set-latency <ms>` (or `default`) with the latency it read before the first round.
So the original suite always runs at 0 ms and the race rounds at the latency the run records;
both changes go through `set-latency`, whose `check` must pass, and the second re-marks the API
log, so the audit window starts just before the rounds.

### The app and the proxy

The Toxiproxy API has no authentication, and `rbw-app` can reach it on loopback, so code running
as `rbw-app` can remove or change the toxic. `rbw-proxy check` detects that, even when the change
was put back before the check: `toxiproxy-server` logs every API request, with its method and URL,
to `/var/lib/rbw/toxiproxy/api.log`, which only `rbw-db` (the server) and root can open, and the
check fails on any `POST`, `DELETE` or other non-`GET` request logged after rbw-proxy's own last
write. It also fails when its own `GET /proxies` does not appear in the log within 5 s, or when the
log has reached 16 MiB, so a log that stopped recording cannot pass. A round counts only when
`rbw-proxy check` passes both before and after it. The driver's `set-latency` before the first
round runs the check before the rounds and keeps its output; a check after the rounds is not run
yet.

The server writes this log itself, not through `rbw-launch`, because the launcher's capture holds
output back in blocks, and a request could stay out of the log for as long as the API is quiet.

### Known limits

- `pg_hba.conf` accepts the app role from `127.0.0.1`, which both the proxy and a direct
  connection come from, so a process running as `rbw-app` can still connect to port 5432 directly
  and skip the delay. Umami connects through `DATABASE_URL`, which is root-owned. For the race
  family the delay is therefore something the app can reach, not part of the protected grading
  boundary of the spec's identity table; the audit above covers changes through the API, not a
  direct connection. Admission and release notes for the race family must say so.
- A request the app sends between rbw-proxy's own writes and its mark (a few milliseconds during
  `start` or `set-latency`) is not audited. The state comparison still runs.

## Image manifest

`/opt/rbw/verifier/image-manifest.json` has the schema `rbw-umami-race-kit-image-manifest/1`. It
holds every field of the base manifest, with `environment.app` replaced by the race app
environment, and a `race` section: the base manifest's schema and SHA-256, the Toxiproxy version,
binary name, download URL and SHA-256, the proxy addresses, and the toxic with its latency.

The manifest step refuses a binary whose hash is not the committed one, a Toxiproxy version other
than 2.12.0, a base manifest that is not a time-zone kit manifest, and an app environment that
differs from the base one in anything but `DATABASE_URL` moving from port 5432 to 5433.

## Host commands

Run from the repository root. `<kit tag>` is a finished `kit/umami` image, built with the driver
and fixture packages for the race family in its `rbw-kit` context.

```sh
docker build -f kit/umami-race/Dockerfile --build-context tz-kit=docker-image://<kit tag> -t <tag> kit
docker build -f kit/umami-race/Dockerfile --build-context tz-kit=docker-image://<kit tag> --build-arg RACE_LATENCY_MS=50 -t <tag> kit
docker run --rm --network none --security-opt no-new-privileges <tag> /opt/rbw/bin/rbw-kit-selftest
docker run --rm --network none <tag> /opt/rbw/bin/rbw-race-selftest
```

Under `linux/amd64` emulation on Apple silicon, the base self-test check
`no-build-outputs-or-caches` fails on `/root/.cache/rosetta`, which the emulator creates in every
container it runs; the released time-zone image fails the same way under emulation. Run the
self-tests on a native build to check an image.

## Tests

```sh
pnpm exec vitest run --project kit-umami-race
```

The static tests check the Dockerfile, the scripts, the hash list and the app environment against
the time-zone kit's. The other tests run the manifest builder and its command line, and
`src/proxy-check.ts` against Toxiproxy `/proxies` answers and API logs in the shape Toxiproxy
2.12.0 writes them, including each way the proxy or its toxic can be changed. The in-image checks
are in `bin/rbw-race-selftest`; they include setting a latency per container and an app-side
delete and re-add of the toxic, which `rbw-proxy check` must catch.
