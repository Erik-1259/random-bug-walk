# Kit image for Umami: pinned Umami source with its locked dependencies and build tools,
# Postgres 15 with a migrated database, and a protected verifier area holding the pristine API
# suite, its own locked test dependencies and its own Node 24 runtime. The app builds and runs
# as rbw-app (UID 2001), Postgres as rbw-db (UID 2002), both through /opt/rbw/bin/rbw-launch.
# See README.md for the layout, the host commands and how each base digest was resolved.
#
#   docker build --build-arg REGISTRY=docker.io -t <tag> kit/umami
#   docker build --build-arg REGISTRY=docker.io --build-context rbw-kit=<dir> -t <tag> kit/umami
#
# REGISTRY may name a mirror of Docker Hub's library images; the digests stay the same.
# Images build natively for the host architecture (arm64 or amd64) from multi-architecture
# index digests.

ARG REGISTRY=docker.io
# node:22-alpine (Node 22.23.3 on Alpine 3.24.2), multi-architecture index digest
ARG NODE22_DIGEST=sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
# node:24-alpine (Node 24.21.0 on Alpine 3.24.2), multi-architecture index digest
ARG NODE24_DIGEST=sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
# postgres:15-alpine (PostgreSQL 15.19 on Alpine 3.24.2), multi-architecture index digest
ARG POSTGRES15_DIGEST=sha256:f7d23353e1b15400d22ebe31189f4d314b87a4c129cc400c8c2d8d4ca127bf81
ARG UMAMI_COMMIT=ec0ff50388c264ed8ce46f00967e92f7e71476ae
# pnpm as pinned by Umami's Dockerfile and package.json engines
ARG PNPM_VERSION=12.3.4
# pnpm for installing the verifier lockfile, the version that generated it
ARG VERIFIER_PNPM_VERSION=10.33.2

FROM ${REGISTRY}/library/node@${NODE22_DIGEST} AS app-base

FROM ${REGISTRY}/library/node@${NODE24_DIGEST} AS verifier-node

# Postgres 15 from the official image, on the same Alpine release as the app image. Keeps the
# server and client binaries, libpq, the extension modules and the share files; drops the JIT
# and the Perl, Python and Tcl languages. Lists the shared libraries the rest needs as apk
# "so:" names, as the official image does for its own runtime dependencies.
FROM ${REGISTRY}/library/postgres@${POSTGRES15_DIGEST} AS postgres
RUN set -euxo pipefail; \
    mkdir -p /out/usr/local/bin /out/usr/local/lib /out/usr/local/share; \
    for tool in postgres initdb pg_ctl pg_isready psql pg_dump pg_restore pg_controldata; do \
      cp -a "/usr/local/bin/$tool" /out/usr/local/bin/; \
    done; \
    cp -a /usr/local/lib/libpq.so* /out/usr/local/lib/; \
    cp -a /usr/local/lib/postgresql /out/usr/local/lib/; \
    rm -rf /out/usr/local/lib/postgresql/bitcode /out/usr/local/lib/postgresql/llvmjit* \
      /out/usr/local/lib/postgresql/*perl* /out/usr/local/lib/postgresql/*python* /out/usr/local/lib/postgresql/pltcl*; \
    cp -a /usr/local/share/postgresql /out/usr/local/share/; \
    mv /out/usr/local/share/postgresql/postgresql.conf.sample.orig /out/usr/local/share/postgresql/postgresql.conf.sample; \
    scanelf --needed --nobanner --format '%n#p' --recursive /out/usr/local | tr ',' '\n' | sort -u \
      | awk 'system("[ -e /out/usr/local/lib/" $1 " ]") == 0 { next } { print "so:" $1 }' > /out/postgres-rundeps; \
    cat /out/postgres-rundeps

# The pinned Umami commit, checked by its hash. Records the tracked files' hashes, checks the
# suite closure against closure.sha256 and against the full tests/api listing, and stages the
# closure at its original relative paths.
FROM app-base AS source
ARG UMAMI_COMMIT
RUN apk add --no-cache git
WORKDIR /src
RUN set -euxo pipefail; \
    git init -q .; \
    git remote add origin https://github.com/umami-software/umami.git; \
    git fetch -q --depth 1 origin "$UMAMI_COMMIT"; \
    git checkout -q FETCH_HEAD; \
    test "$(git rev-parse HEAD)" = "$UMAMI_COMMIT"; \
    git ls-files -z | xargs -0 sha256sum > /rbw-app-tracked.sha256; \
    rm -rf .git
COPY closure.sha256 /rbw/closure.sha256
RUN set -euxo pipefail; \
    sha256sum -c /rbw/closure.sha256 > /dev/null; \
    { find tests/api -type f; echo playwright.api.config.ts; echo src/lib/analytics-query.ts; } \
      | grep -v '^tests/api/\.runtime/' | LC_ALL=C sort > /tmp/closure-found; \
    awk '{ print $2 }' /rbw/closure.sha256 > /tmp/closure-listed; \
    cmp /tmp/closure-listed /tmp/closure-found; \
    while read -r _ path; do \
      mkdir -p "/suite/$(dirname "$path")"; \
      cp "$path" "/suite/$path"; \
    done < /rbw/closure.sha256
# Declared build input, as in the builder stage of Umami's Dockerfile: docker/proxy.ts becomes
# the Next proxy (middleware). src/proxy.ts is not a tracked file; the manifest records its hash.
RUN test ! -e src/proxy.ts && cp docker/proxy.ts src/proxy.ts

# pnpm, installed as an unprivileged user so its install script never runs as root.
FROM app-base AS pnpm
ARG PNPM_VERSION
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
USER node
RUN npm install --global --prefix /home/node/pnpm --no-audit --no-fund "pnpm@${PNPM_VERSION}" \
    && /home/node/pnpm/bin/pnpm --version

# Umami's locked dependencies, installed as in the deps stage of Umami's Dockerfile, but as an
# unprivileged user, and with strictDepBuilds set through pnpm's environment instead of by
# appending to the tracked pnpm-workspace.yaml. They are installed at /workspace/app, the path
# they are copied to, because pnpm records absolute project paths in node_modules.
FROM app-base AS deps
RUN apk add --no-cache libc6-compat && install -d -o node -g node /workspace/app
COPY --from=pnpm --chown=node:node /home/node/pnpm /home/node/pnpm
USER node
WORKDIR /workspace/app
COPY --from=source --chown=node:node /src/package.json /src/pnpm-lock.yaml /src/pnpm-workspace.yaml ./
COPY --from=source --chown=node:node /src/packages/api-client/package.json ./packages/api-client/
COPY --from=source --chown=node:node /src/packages/mcp/package.json ./packages/mcp/
COPY --from=source --chown=node:node /src/packages/mcp/bin ./packages/mcp/bin/
ENV PATH=/home/node/pnpm/bin:$PATH \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    pnpm_config_strict_dep_builds=false \
    CHECKPOINT_DISABLE=1
RUN pnpm install --frozen-lockfile \
    && ls node_modules/.pnpm/@prisma+engines@*/node_modules/@prisma/engines/*engine*

# The verifier's test dependencies from the committed verifier lockfile, with no lifecycle
# scripts and no browsers.
FROM verifier-node AS verifier-deps
ARG VERIFIER_PNPM_VERSION
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
USER node
WORKDIR /home/node/verifier
COPY --chown=node:node verifier/package.json verifier/pnpm-lock.yaml ./
RUN npm install --global --prefix /home/node/pnpm --no-audit --no-fund --ignore-scripts "pnpm@${VERIFIER_PNPM_VERSION}" \
    && /home/node/pnpm/bin/pnpm install --frozen-lockfile --ignore-workspace --ignore-scripts

# The Inter font files that Umami's layout loads through next/font/google, checked against
# fonts.sha256, for the offline cold build (see bin/rbw-build-app).
FROM app-base AS fonts
WORKDIR /fonts
COPY fonts/fonts.sha256 /rbw/fonts.sha256
RUN set -euxo pipefail; \
    while read -r _ name; do \
      wget -q -O "$name" "https://fonts.gstatic.com/s/inter/v20/$name"; \
    done < /rbw/fonts.sha256; \
    sha256sum -c /rbw/fonts.sha256

# The driver and fixture packages. Empty unless the build is given --build-context rbw-kit=<dir>,
# which replaces this stage. The copy of Alpine's empty /var/empty gives the default stage a root
# directory, so the final stage can copy "/" from it.
FROM scratch AS rbw-kit
COPY --from=app-base /var/empty/ /

FROM app-base AS kit
ARG NODE22_DIGEST
ARG NODE24_DIGEST
ARG POSTGRES15_DIGEST
ARG UMAMI_COMMIT

COPY --from=postgres /out/ /
RUN set -euxo pipefail; \
    xargs apk add --no-cache libc6-compat tini setpriv tzdata tmux curl busybox-extras icu-data-full < /postgres-rundeps; \
    rm /postgres-rundeps; \
    postgres --version
COPY --from=pnpm --chown=0:0 /home/node/pnpm/lib/node_modules/pnpm /usr/local/lib/node_modules/pnpm
RUN ln -s ../lib/node_modules/pnpm/pnpm /usr/local/bin/pnpm && pnpm --version

RUN set -euxo pipefail; \
    addgroup -g 2001 rbw-app; \
    adduser -D -H -h /var/tmp/rbw-app -s /sbin/nologin -G rbw-app -u 2001 rbw-app; \
    addgroup -g 2002 rbw-db; \
    adduser -D -H -h /var/tmp/rbw-db -s /sbin/nologin -G rbw-db -u 2002 rbw-db

COPY --from=source --chown=0:0 /src /workspace/app
COPY --from=deps --chown=0:0 /workspace/app/node_modules /workspace/app/node_modules
COPY --from=deps --chown=0:0 /workspace/app/packages/api-client/node_modules /workspace/app/packages/api-client/node_modules
COPY --from=deps --chown=0:0 /workspace/app/packages/mcp/node_modules /workspace/app/packages/mcp/node_modules

COPY --chown=0:0 --chmod=0755 bin/ /opt/rbw/bin/
COPY --chown=0:0 etc/ /opt/rbw/etc/
COPY --chown=0:0 build-outputs.txt /opt/rbw/etc/build-outputs.txt
COPY --chown=0:0 fonts/next-font-google-mocks.cjs /opt/rbw/build/next-font-google-mocks.cjs
COPY --from=fonts --chown=0:0 /fonts/ /opt/rbw/build/fonts/

COPY --from=verifier-node --chown=0:0 /usr/local/bin/node /opt/rbw/verifier/node/bin/node
COPY --from=verifier-deps --chown=0:0 /home/node/verifier/node_modules /opt/rbw/verifier/node_modules
COPY --chown=0:0 verifier/package.json verifier/pnpm-lock.yaml /opt/rbw/verifier/
COPY --from=source --chown=0:0 /suite /opt/rbw/verifier/suite
COPY --chown=0:0 closure.sha256 /opt/rbw/verifier/closure.sha256
COPY --from=source --chown=0:0 /rbw-app-tracked.sha256 /opt/rbw/verifier/app-tracked.sha256
COPY --from=rbw-kit / /opt/rbw/verifier/kit/

# Ownership and modes. The verifier tree is root-only. The app tree is root-owned and
# read-only to rbw-app, except the paths in build-outputs.txt. rbw-app and rbw-db write only
# their own temp directories, and rbw-db its database directory. /tmp and /var/tmp are not
# writable by either. No file keeps a setuid or setgid bit.
RUN set -euxo pipefail; \
    chmod 0755 /opt/rbw /opt/rbw/bin /opt/rbw/etc /opt/rbw/build; \
    chmod 0644 /opt/rbw/etc/*; \
    chmod -R u=rwX,go=rX /opt/rbw/build; \
    chown -R root:root /opt/rbw/verifier; \
    find /opt/rbw/verifier -type d -exec chmod 0700 {} +; \
    find /opt/rbw/verifier -type f -perm /111 -exec chmod 0700 {} +; \
    find /opt/rbw/verifier -type f ! -perm /111 -exec chmod 0600 {} +; \
    install -d -o root -g root -m 0755 /var/lib/rbw; \
    install -d -o root -g root -m 0700 /var/lib/rbw/results; \
    install -d -o root -g root -m 0700 /var/lib/rbw/logs /run/rbw; \
    install -d -o root -g rbw-db -m 0770 /run/rbw-pg; \
    install -d -o rbw-db -g rbw-db -m 0700 /var/lib/rbw/pgdata; \
    install -d -o rbw-db -g rbw-db -m 0700 /var/tmp/rbw-db; \
    install -d -o rbw-app -g rbw-app -m 0700 /var/tmp/rbw-app; \
    chmod 0755 /tmp /var/tmp; \
    chmod -R u=rwX,go=rX /workspace; \
    cd /workspace/app; \
    while read -r kind path; do \
      case $kind in \
        '' | '#'*) ;; \
        dir) test ! -e "$path"; install -d -o rbw-app -g rbw-app -m 0755 "$path" ;; \
        file) test ! -e "$path"; : > "$path"; chown rbw-app:rbw-app "$path"; chmod 0644 "$path" ;; \
        sticky) test -d "$path"; chown root:rbw-app "$path"; chmod 1775 "$path" ;; \
        tracked) test -f "$path"; chown rbw-app:rbw-app "$path" ;; \
        *) echo "unknown build output kind: $kind"; exit 1 ;; \
      esac; \
    done < /opt/rbw/etc/build-outputs.txt; \
    find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod ug-s {} +

# A migrated database, so the server is ready soon after start.
RUN /opt/rbw/bin/rbw-db-init

# The image manifest, from the verifier's Node 24. The script is bind-mounted, not shipped.
RUN --mount=type=bind,source=src/manifest.ts,target=/mnt/rbw/manifest.ts \
    set -euxo pipefail; \
    set --; \
    for font in /opt/rbw/build/fonts/*.woff2; do set -- "$@" --build-input "$font=$font"; done; \
    /opt/rbw/verifier/node/bin/node /mnt/rbw/manifest.ts \
      --out /opt/rbw/verifier/image-manifest.json \
      --umami-commit "$UMAMI_COMMIT" \
      --umami-lock /workspace/app/pnpm-lock.yaml \
      --verifier-lock /opt/rbw/verifier/pnpm-lock.yaml \
      --app-tracked /opt/rbw/verifier/app-tracked.sha256 \
      --app-image "node:22-alpine=$NODE22_DIGEST" \
      --verifier-image "node:24-alpine=$NODE24_DIGEST" \
      --postgres-image "postgres:15-alpine=$POSTGRES15_DIGEST" \
      --alpine-release /etc/alpine-release \
      --node-version "$(node --version)" \
      --verifier-node-version "$(/opt/rbw/verifier/node/bin/node --version)" \
      --pnpm-version "$(pnpm --version)" \
      --postgres-version "$(postgres --version)" \
      --apk-installed /lib/apk/db/installed \
      --app-env /opt/rbw/etc/app.environment \
      --build-env /opt/rbw/etc/build.environment \
      --build-outputs /opt/rbw/etc/build-outputs.txt \
      --closure /opt/rbw/verifier/closure.sha256 \
      --build-input src/proxy.ts=docker/proxy.ts=/workspace/app/src/proxy.ts \
      --build-input /opt/rbw/build/next-font-google-mocks.cjs=/opt/rbw/build/next-font-google-mocks.cjs \
      "$@"; \
    chmod 0600 /opt/rbw/verifier/image-manifest.json; \
    rm -rf /root/.cache /root/.local /root/.npm

WORKDIR /workspace/app
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/opt/rbw/bin/rbw-kit-selftest"]
