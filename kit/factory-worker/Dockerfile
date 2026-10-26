# The factory worker image: Node 24, git, this repository at one commit with the controller's locked
# runtime dependencies, and the prepared catalog packages, each named by its own sha256. The factory
# web service starts it on Vercel Sandbox by digest (RBW_FACTORY_WORKER_IMAGE); its entry point is
# the command the service runs:
#   node /opt/rbw/repo/tools/controller/src/cli.ts factory-worker --request-id <uuid> --deadline-at <UTC time>
#   node /opt/rbw/repo/tools/controller/src/cli.ts factory-worker --validation-id <uuid>
#
# Build it with kit/factory-worker/build.sh, which makes the context from the committed tree of one
# commit (nothing uncommitted, no credentials) and the prepared directory:
#   <context>/repo/              git archive of the commit
#   <context>/factory-packages/  the prepared directory, flat: index.json and the archives it names,
#                                each named <sha256>.tar.gz
# The credentials reach the sandbox as environment values at create time, never through the image.

ARG REGISTRY=docker.io
# node:24-alpine (Node 24.21.0 on Alpine 3.24.2), multi-architecture index digest, as kit/umami/Dockerfile pins it
ARG NODE24_DIGEST=sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

FROM ${REGISTRY}/library/node@${NODE24_DIGEST}

RUN apk add --no-cache git ca-certificates \
    && npm install --global --no-audit --no-fund pnpm@10.33.2

WORKDIR /opt/rbw/repo
COPY repo/ ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@rbw/controller..." \
    && rm -rf /root/.cache /root/.local/share/pnpm

# The prepared directory: index.json and every archive it names, each archive named by the sha256 of
# its bytes; the build fails on any other file, a missing index or an archive the index names but the
# directory lacks (kit/factory-worker/check-packages.mjs).
COPY factory-packages/ /opt/rbw/factory-packages/
RUN node /opt/rbw/repo/kit/factory-worker/check-packages.mjs /opt/rbw/factory-packages \
    && chmod -R a-w /opt/rbw/factory-packages
