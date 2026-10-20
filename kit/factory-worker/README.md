# Factory worker image

The image the factory web service starts on Vercel Sandbox for each request and each validation run.
It holds Node 24, git, this repository at one commit with the controller's locked runtime dependencies,
and the prepared catalog packages (the bug-case archives and validator core archives), each file named by
the sha256 of its bytes, under `/opt/rbw/factory-packages/`. The worker reads the packages from the image,
so no Blob credentials are needed inside any sandbox. The command it runs is described in
[the controller README](../../tools/controller/README.md#factory-worker).

Nothing here pushes, uploads or starts anything. The conductor runs the commands below.

## Build

From the repository root, with the prepared directory written by the exporter's prepare mode
(a flat directory of `<sha256>.<extension>` files):

```sh
kit/factory-worker/build.sh <commit> <prepared directory> rbw-factory-worker:local
```

The script builds for `linux/amd64` (Vercel Sandbox runs that platform only) from a new temporary context:
`git archive <commit>` and a copy of the prepared directory. The Dockerfile used is the one in that
commit, and the image carries the commit as its `org.opencontainers.image.revision` label. The build
fails when a prepared file's name is not the sha256 of its bytes, when the directory is empty, or when it
holds anything but regular files.

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
that is not pinned by digest. The web deployment and the worker image must come from commits with the same
`tools/controller/src/factory-{profile,ledger}.ts` and `packages/envelope` (with its rate sheet), because
both sides compute the same operation IDs and envelopes.

## Upload the packages to Blob (planned)

The same prepared directory is published content-addressed to the public Blob store for the download
route, through the trusted publisher. The publisher has no command for a prepared directory yet, so this
step is planned and nothing is uploaded today. The planned layout is one object per file, keyed
`factory/packages/<file name>`, with each file's name its own sha256.
