# Race kit image for Umami: the time-zone kit image (kit/umami) with Toxiproxy between Umami and
# Postgres. It is an overlay: the base image is a finished kit/umami image, unchanged, and this
# file only adds layers on top, so the time-zone image, its inputs and its digest stay as they are.
# See README.md.
#
#   docker build -f kit/umami-race/Dockerfile --build-context tz-kit=docker-image://<kit tag> \
#     [--build-arg RACE_LATENCY_MS=<ms>] -t <tag> kit
#
# The build context is the kit directory, so the manifest step can reuse kit/umami's parsers.
# REGISTRY may name a mirror of Docker Hub's library images; the digest stays the same.

ARG REGISTRY=docker.io
# node:22-alpine (Node 22.23.3 on Alpine 3.24.2), multi-architecture index digest, the same as
# kit/umami's app base; used only to download and check the Toxiproxy binary
ARG NODE22_DIGEST=sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
# toxiproxy-server, checked against umami-race/toxiproxy.sha256
ARG TOXIPROXY_VERSION=2.12.0
# The fixed latency of the toxic on the proxy's downstream (Postgres to Umami), in milliseconds
ARG RACE_LATENCY_MS=0

# The static toxiproxy-server binary for the target architecture, checked by its committed hash.
FROM ${REGISTRY}/library/node@${NODE22_DIGEST} AS toxiproxy
ARG TOXIPROXY_VERSION
ARG TARGETARCH
COPY umami-race/toxiproxy.sha256 /rbw/toxiproxy.sha256
RUN set -euxo pipefail; \
    name="toxiproxy-server-linux-${TARGETARCH}"; \
    grep "  ${name}\$" /rbw/toxiproxy.sha256 > /rbw/pinned.sha256; \
    wget -q -O "/rbw/${name}" "https://github.com/Shopify/toxiproxy/releases/download/v${TOXIPROXY_VERSION}/${name}"; \
    cd /rbw && sha256sum -c pinned.sha256; \
    install -m 0755 "/rbw/${name}" /rbw/toxiproxy-server; \
    test "$(/rbw/toxiproxy-server -version)" = "toxiproxy-server version ${TOXIPROXY_VERSION}"

# The finished time-zone kit image, from --build-context tz-kit=docker-image://<kit tag>.
FROM tz-kit AS race
ARG TOXIPROXY_VERSION
ARG RACE_LATENCY_MS
ARG TARGETARCH

COPY --from=toxiproxy --chown=0:0 /rbw/toxiproxy-server /usr/local/bin/toxiproxy-server

# Keeps the base start, stop and self-test scripts under a -base name; the race ones wrap them.
RUN set -euxo pipefail; \
    for script in rbw-start rbw-stop rbw-kit-selftest; do \
      test -f "/opt/rbw/bin/$script"; test ! -e "/opt/rbw/bin/$script-base"; \
      mv "/opt/rbw/bin/$script" "/opt/rbw/bin/$script-base"; \
    done; \
    mv /opt/rbw/verifier/image-manifest.json /opt/rbw/verifier/base-image-manifest.json
COPY --chown=0:0 --chmod=0755 umami-race/bin/ /opt/rbw/bin/
COPY --chown=0:0 --chmod=0644 umami-race/etc/app.environment /opt/rbw/etc/app.environment
COPY --chown=0:0 --chmod=0600 umami-race/toxiproxy.sha256 /opt/rbw/verifier/toxiproxy.sha256
RUN set -euxo pipefail; \
    case "$RACE_LATENCY_MS" in \
      '' | 0?* | *[!0-9]*) echo "RACE_LATENCY_MS must be a whole number of milliseconds"; exit 1 ;; \
    esac; \
    test "${#RACE_LATENCY_MS}" -le 5 && test "$RACE_LATENCY_MS" -le 10000; \
    printf '# The latency toxic on the Toxiproxy downstream, in milliseconds, from the image build.\nRBW_RACE_LATENCY_MS=%s\n' \
      "$RACE_LATENCY_MS" > /opt/rbw/etc/race.environment; \
    chmod 0644 /opt/rbw/etc/race.environment

# The race manifest, from the verifier's Node 24. The scripts are bind-mounted, not shipped.
RUN --mount=type=bind,source=.,target=/mnt/kit \
    set -euxo pipefail; \
    /opt/rbw/verifier/node/bin/node /mnt/kit/umami-race/src/race-manifest.ts \
      --out /opt/rbw/verifier/image-manifest.json \
      --base-manifest /opt/rbw/verifier/base-image-manifest.json \
      --app-env /opt/rbw/etc/app.environment \
      --race-env /opt/rbw/etc/race.environment \
      --toxiproxy-hashes /opt/rbw/verifier/toxiproxy.sha256 \
      --toxiproxy-binary /usr/local/bin/toxiproxy-server \
      --toxiproxy-version "$TOXIPROXY_VERSION" \
      --arch "$TARGETARCH"; \
    chmod 0600 /opt/rbw/verifier/image-manifest.json; \
    find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod ug-s {} +; \
    rm -rf /root/.cache /root/.local /root/.npm
