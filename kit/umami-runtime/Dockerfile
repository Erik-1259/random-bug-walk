# Runtime image for Umami: a finished time-zone kit image (kit/umami) without the app source, the
# fixture and the list of the source's file hashes. A debugging agent and every validation copy run
# in it: the agent copies its source tree to /workspace/app, a copy gets the state's source tree and
# the validator's fixture, and /opt/rbw/bin/rbw-prepare-app readies the tree for the kit's cold
# build. See README.md.
#
#   docker build --build-context umami-kit=docker-image://<kit image> -t <tag> kit/umami-runtime
#
# Every instruction copies files; nothing runs a program, so the image builds for the kit image's
# own architecture without emulation, and no app source file and no fixture file is in any layer.

# The finished kit image, from --build-context umami-kit=docker-image://<kit image>: its Postgres
# with the database migrated at build time, the verifier's Node and test dependencies, the driver
# and the pristine suite closure, and Umami's locked dependencies.
FROM umami-kit AS kit

FROM scratch AS runtime
# Everything of the kit except its app tree, its fixture package and the hash list of its app's
# tracked files. Each excluded path is answer material for a debugging agent: the clean source,
# the checks with their expected outcomes, and every clean file's hash.
COPY --from=kit \
  --exclude=proc --exclude=sys --exclude=dev \
  --exclude=workspace/app \
  --exclude=opt/rbw/verifier/kit/umami-fixture \
  --exclude=opt/rbw/verifier/app-tracked.sha256 \
  / /
# Umami's locked dependencies, at the paths they were installed at, because pnpm records absolute
# project paths in node_modules.
COPY --from=kit /workspace/app/node_modules /workspace/app/node_modules
COPY --from=kit /workspace/app/packages/api-client/node_modules /workspace/app/packages/api-client/node_modules
COPY --from=kit /workspace/app/packages/mcp/node_modules /workspace/app/packages/mcp/node_modules

COPY --chown=0:0 --chmod=0755 bin/ /opt/rbw/bin/

# The kit's own configuration, which a scratch stage does not inherit.
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_VERSION=22.23.3 \
    YARN_VERSION=1.22.22
WORKDIR /workspace/app
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/opt/rbw/bin/rbw-runtime-selftest"]
