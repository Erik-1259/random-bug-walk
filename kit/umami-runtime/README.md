# Umami runtime image

The build definition of the runtime image of the Umami host: a finished time-zone kit image
(`kit/umami`) without the app source, without the fixture package and without the list of the
app's file hashes. A debugging agent runs its copy of Umami in this image, and so does every
validation copy that `@rbw/host-umami` plans. This is part of a hackathon prototype.

## Why a separate image

The kit image holds three things a debugging agent must not see, because each one shows where the
planted change is:

- the clean source of the pinned Umami commit at `/workspace/app`;
- the fixture package at `/opt/rbw/verifier/kit/umami-fixture`: the verification checks and their
  expected outcomes for the clean, buggy and fixed source;
- `/opt/rbw/verifier/app-tracked.sha256`, the SHA-256 of every tracked file at the pinned commit.

The agent runs as root in its container, so the verifier area's root-only modes do not hide them.
The runtime image leaves all three out. A validation copy receives its source tree and the
validator's fixture when it is created, and the kit's own build and start scripts run as before.

## Files

| Path | Purpose |
|---|---|
| `Dockerfile` | The image: file copies from a finished kit image, passed in as a build context. |
| `bin/rbw-prepare-app` | Readies a placed source tree for the kit's cold build (see [Preparing a source tree](#preparing-a-source-tree)). |
| `bin/rbw-runtime-selftest` | In-image checks of the image's contents; the image's default command. |
| `test/` | Static tests (Vitest). |

## What the image holds

Every instruction of the Dockerfile copies files; none runs a program. So the image builds for the
kit image's own architecture without emulation, and no app source file and no fixture file is in
any of its layers. A build that removed them from the kit image would leave them in the kit's
lower layers.

| Path | In the runtime image |
|---|---|
| `/workspace/app/node_modules`, `/workspace/app/packages/api-client/node_modules`, `/workspace/app/packages/mcp/node_modules` | Kept, at the paths they were installed at: pnpm records absolute project paths in `node_modules`. |
| Every other path under `/workspace/app` | Left out. |
| `/opt/rbw/verifier/kit/umami-fixture` | Left out. |
| `/opt/rbw/verifier/app-tracked.sha256` | Left out. |
| `/opt/rbw/bin/rbw-prepare-app`, `/opt/rbw/bin/rbw-runtime-selftest` | Added. |
| Everything else | Kept unchanged, owners and modes included: Postgres 15 with the database migrated when the kit was built, `/opt/rbw/bin`, `/opt/rbw/etc` and `/opt/rbw/build`, and in the root-only verifier area the verifier's Node 24 and test dependencies, the pristine suite closure and its list, the driver, the schema package and the kit's image manifest. |

The kit's image manifest (`/opt/rbw/verifier/image-manifest.json`) stays byte for byte, so its
SHA-256 names the kit image the runtime image was made from. The image sets the kit's environment
(`PATH`, `NODE_VERSION`, `YARN_VERSION`), working directory (`/workspace/app`) and entry point
(`tini`), which a scratch stage does not inherit.

## Preparing a source tree

`rbw-prepare-app`, run as root once after a source tree is placed at `/workspace/app` and before
`rbw-build-app`:

1. refuses a tree without `package.json` or `docker/proxy.ts`, or one that holds a link;
2. makes every file and directory of the tree outside the locked dependencies root-owned and
   read-only to `rbw-app` (`u=rwX,go=rX`), as the kit's tree is, and leaves `node_modules` as it is;
3. copies `docker/proxy.ts` to `src/proxy.ts` when the tree has none, as the kit's image build and
   Umami's own builder stage do (the Next proxy, which Umami calls its middleware);
4. creates every build output that `/opt/rbw/etc/build-outputs.txt` lists and gives it to
   `rbw-app` as the kit's image build does: the empty directories and files, the two sticky
   package directories (root:`rbw-app`, 1775) and the tracked files the build regenerates.

It exits 0 when the tree is ready, 1 when it refuses the tree, with the reason on standard error,
and 2 when it is not run as root. On a prepared tree, the kit's cold-build check (`rbw-check-cold`)
passes and `rbw-build-app`, `rbw-start` and `rbw-stop` work as in the kit image.

The bug-case and validator packages record no file modes, so placed files are not executable.
Three of Umami's tracked files are executable in the kit's tree (`scripts/start-docker.sh`,
`podman/install-systemd-user-service` and `packages/mcp/bin/umami-mcp.js`); neither the build
nor the kit's start script runs them directly.

## How a copy uses the image

The copy script in `@rbw/host-umami` (`COPY_SCRIPT` in `packages/host-umami/src/copy-plans.ts`)
runs as root in a fresh container, after the runner placed the state's whole source tree at
`/workspace/app` and the validator's `fixture/` and `job/` directories under `/var/lib/rbw`:

1. it moves `/var/lib/rbw/fixture` to `/opt/rbw/verifier/kit/umami-fixture`, where the driver
   reads the fixture, and makes it root-only like the rest of the verifier area (directories 0700,
   files 0600);
2. it runs `rbw-prepare-app`;
3. it writes that step's exit status to `prepare.exit` in its output directory, and stops with
   status 92 when the step failed;
4. it runs the local runner's copy script unchanged: the driver's `freeze`, then `run` of the
   copy's trial of the frozen job.

## Host commands

Run from the repository root on a host with Docker. Replace `<kit image>` with a local tag or a
`<repository>@<digest>` reference of a finished `kit/umami` image, and `<tag>` with a tag for
the runtime image.

```sh
docker build --build-context umami-kit=docker-image://<kit image> -t <tag> kit/umami-runtime
docker build --platform linux/amd64 --build-context umami-kit=docker-image://<amd64 kit image> -t <tag> kit/umami-runtime
docker run --rm --network none --security-opt no-new-privileges <tag>
```

The second command builds the amd64 image from an amd64 kit image on any host, because no
instruction runs a program. The third runs the self-test. Besides its checks, the self-test prints
the frozen original suite's `original_suite_sha256` (the driver's `freeze` in the image) and the
kit manifest's `kit_manifest_sha256`; a runtime image made from the pinned kit image gives the
`original_suite.sha256` and `kit.kit_sha256` of `@rbw/host-umami`'s pins.

## Tests

```sh
pnpm exec vitest run --root kit/umami-runtime
```

The static tests check the Dockerfile and the scripts. The in-image checks are in
`bin/rbw-runtime-selftest`. On a prepared tree, the kit's own `rbw-kit-selftest`, which the image
keeps, passes every check except `app-tracked-files-match-pinned-commit`, whose list the runtime
image leaves out.

## What it does not do

- It does not check a placed source tree against the pinned commit; the host adapter's copy plans
  check every state's tree against its pinned source before a copy is planned.
- It does not restore file modes that the packages do not record.
- It does not change the kit image: `kit/umami`, its build and its digest stay as they are, and the
  released case's judge job still runs in the kit image.
