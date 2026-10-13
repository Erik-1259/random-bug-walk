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
| `bin/rbw-proxy` | Starts, checks and stops Toxiproxy. |
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

The driver and the local runner call `rbw-start`, `rbw-stop` and `rbw-kit-selftest` by their usual
paths, so they need no change to use the race image.

## The proxy

| What | Where |
|---|---|
| Postgres | `127.0.0.1:5432`, unchanged |
| Toxiproxy API | `127.0.0.1:8474` |
| Proxy `postgres` | listens on `127.0.0.1:5433`, forwards to `127.0.0.1:5432` |
| Toxic `latency_downstream` | type `latency`, stream `downstream` (Postgres to Umami), toxicity 1, jitter 0, latency `RBW_RACE_LATENCY_MS` |

`toxiproxy-server` runs as `rbw-db` through `rbw-launch`, with `-seed 1`; its output goes to
`/var/lib/rbw/logs/toxiproxy.stdout.log` and `toxiproxy.stderr.log`. `rbw-start` runs the base
script with `--db-only`, then `rbw-proxy start`, then the base script again, which finds Postgres
running and starts Umami; that second call's `ready_ms` does not include the proxy's start-up.
`rbw-start --db-only` starts Postgres and the proxy. `rbw-stop` runs the base stop, then stops the
proxy.

`rbw-proxy start` creates the proxy, replaces the toxic with the configured one and then runs
`rbw-proxy check`, which exits 0 only when the API reports exactly one proxy and exactly one toxic,
both as configured.

The latency defaults to 0 ms until the flakiness study picks a value. A different value is a
rebuild of the overlay with `--build-arg RACE_LATENCY_MS=<ms>`, a whole number from 0 to 10000,
which takes seconds; the manifest records it.

### Known limits

- The Toxiproxy API has no authentication, and `rbw-app` can reach it on loopback. A process
  running as `rbw-app` can remove the toxic; `rbw-proxy check` then fails. A caller that relies on
  the delay should run `rbw-proxy check` after the app has run.
- `pg_hba.conf` accepts the app role from `127.0.0.1`, which both the proxy and a direct
  connection come from, so a process running as `rbw-app` can still connect to port 5432 directly.
  Umami connects through `DATABASE_URL`, which is root-owned.

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

On 2026-10-13, on an Apple silicon laptop with Docker Desktop, the overlay built in 24 s for
`linux/amd64` (under emulation) on the time-zone image `rbw-umami-kit@sha256:295433e5a8b0dc81e1492a4d18220f5e1d323a78bc38cbb5eca688efde7863ff`, and in 14 s
for `linux/arm64`. The first 29 layers of the amd64 race image are the 29 layers of that base
image. The arm64 race image passed every base and race self-test check. Under amd64 emulation the
race checks passed and the base check `no-build-outputs-or-caches` failed on `/root/.cache/rosetta`,
which the emulator creates in every container it runs; the released time-zone image fails the same
way under emulation.

## Tests

```sh
pnpm exec vitest run --project kit-umami-race
```

The static tests check the Dockerfile, the scripts, the hash list and the app environment against
the time-zone kit's, and the manifest builder. The in-image checks are in `bin/rbw-race-selftest`.
