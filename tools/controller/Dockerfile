# The judge controller image: Node 24, git (the planted copy's projection audit commits with it)
# and this repository at one commit, with the controller's locked runtime dependencies. The judge
# route starts it on Vercel Sandbox by digest; its entry point is the command the route runs:
#   node /opt/rbw/repo/tools/controller/src/cli.ts run --job-kind judge_verify --prebuilt ...
#
# The build context is the committed tree of that commit, so nothing uncommitted (no credentials,
# no audit inputs, no local files) can enter the image. From the repository root:
#
#   git archive --format=tar <commit> | docker build --platform linux/amd64 -f tools/controller/Dockerfile -t <tag> -
#
# The audit inputs are in the private store beside the judge job, and the credentials reach the
# sandbox as environment values at create time.

ARG REGISTRY=docker.io
# node:24-alpine (Node 24.21.0 on Alpine 3.24.2), multi-architecture index digest, as kit/umami/Dockerfile pins it
ARG NODE24_DIGEST=sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

FROM ${REGISTRY}/library/node@${NODE24_DIGEST}

RUN apk add --no-cache git ca-certificates \
    && npm install --global --no-audit --no-fund pnpm@10.33.2

WORKDIR /opt/rbw/repo
COPY . .
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@rbw/controller..." \
    && rm -rf /root/.cache /root/.local/share/pnpm
