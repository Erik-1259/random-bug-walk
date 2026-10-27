# Factory worker image

The image the factory web service starts on Vercel Sandbox for each request and each validation run.
It holds Node 24, git, this repository at one commit with the controller's locked runtime dependencies,
and the prepared catalog packages (`index.json` and the bug-case and validator core archives it names, each
archive named by the sha256 of its bytes) under `/opt/rbw/factory-packages/`. The worker reads the packages
from the image, so no storage credentials are needed inside any sandbox. The command it runs is described in
[the controller README](../../tools/controller/README.md#factory-worker).

Nothing here pushes, uploads or starts anything. The conductor runs the commands below.

## Build

From the repository root, with the prepared directory written by the exporter's prepare mode
(`node tools/case-package/src/cli.ts prepare ...`: a flat directory of `index.json` and `<sha256>.tar.gz` archives):

```sh
kit/factory-worker/build.sh <commit> <prepared directory> rbw-factory-worker:local
```

The script builds for `linux/amd64` (Vercel Sandbox runs that platform only) from a new temporary context:
`git archive <commit>` and a copy of the prepared directory. The Dockerfile used is the one in that
commit, and the image carries the commit as its `org.opencontainers.image.revision` label. The build
runs `check-packages.mjs` on the packages and fails when `index.json` is missing, is not
`rbw-prepared-packages/1` or lists no entries, when an archive's name is not the sha256 of its bytes, when
an entry's bug case or validator core archive is missing, or when the directory holds anything but regular
files. The same check runs on a directory before a build:

```sh
node kit/factory-worker/check-packages.mjs <prepared directory>
```

## Push to Vercel Container Registry

`<vcr repository>` is the image's repository in VCR (`<team>/<project>/<repository>`, under VCR's registry
host); pushing needs a Docker login to VCR as Vercel's documentation describes.

```sh
docker tag rbw-factory-worker:local <registry host>/<vcr repository>:<tag>
docker push <registry host>/<vcr repository>:<tag>
docker image inspect --format '{{json .RepoDigests}}' rbw-factory-worker:local
```

The last command lists the pushed digest, `sha256:<digest>`. The web service's configuration value
`RBW_FACTORY_WORKER_IMAGE` is then `<vcr repository>@sha256:<digest>`; the service refuses a worker image
that is not pinned by digest. The worker gets the same value as a create-time environment value, with its
other settings, and uses it for its copies: each copy's sandbox starts from the copy plan's image name in
the worker image's namespace (`<team>/<project>`), pinned by the plan's digest. The hosts' runtime images
are therefore pushed to the same VCR project under the name their committed pin gives (for example
`<team>/<project>/umami-runtime`); the committed pins name no registry. Without the value, or for a pin
whose digest is a placeholder, the worker refuses every copy before launching it.

The web deployment and the worker image must come from commits with the same
`tools/controller/src/factory-{profile,ledger}.ts` and `packages/envelope` (with its rate sheet), because
both sides compute the same operation IDs and envelopes.

## The packages in the web service

The web service reads the same prepared directory, bundled into its build (no object storage). The
service side is in `packages/web`: the deploy copies the directory into `packages/web/factory-packages`,
whose `index.json` must have the same SHA-256 as the image's (see
[Deploying on Vercel](../../packages/web/README.md#deploying-on-vercel)). A pushed linux/amd64 build of
this image runs the requests of the production site and of hosted preview deployments.
