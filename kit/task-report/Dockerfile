# Kit image for the task-report host: Node 24, PostgreSQL 15 binaries, the baseline app's
# dependencies installed from its vendored lockfile, and a root-only evaluator area holding the
# original suite, the evaluator package (suite runner, F3 check, data, protocol, baseline manifest)
# and its own copy of the same dependencies. One container (or one microVM) is one copy: the host
# places one app source tree in /workspace/app and runs /opt/rbw/bin/rbw-copy. The database runs
# as rbw-db (UID 2002) and the app as rbw-app (UID 2001), both through rbw-launch, which is the
# Umami kit's launcher. Neither user can read /opt/rbw/evaluator or /var/lib/rbw/results. See
# README.md. Built by the package's runner (`node packages/host-task-report/src/local/cli.ts build`):
#
#   docker build --build-arg REGISTRY=docker.io \
#     --build-context app=hosts/task-report/app \
#     --build-context evaluator=packages/host-task-report \
#     --build-context launcher=kit/umami/bin \
#     -t rbw-task-report:<name> kit/task-report
#
# The base digests are the multi-architecture index digests the custom host harness and the Umami
# kit use, so the image builds natively for arm64 or amd64. Only the dependency install uses the
# network (the npm registry); copies run with no network.

ARG REGISTRY=docker.io
# node:24-alpine (Node 24.21.0 on Alpine 3.24.2), multi-architecture index digest
ARG NODE24_DIGEST=sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
# postgres:15-alpine (PostgreSQL 15.19 on Alpine 3.24.2), multi-architecture index digest
ARG POSTGRES15_DIGEST=sha256:f7d23353e1b15400d22ebe31189f4d314b87a4c129cc400c8c2d8d4ca127bf81

FROM ${REGISTRY}/library/node@${NODE24_DIGEST} AS node24

# PostgreSQL 15 from the official image, as in the Umami kit: server and client binaries, libpq,
# the extension modules and the share files, without the JIT and the Perl, Python and Tcl
# languages, and the shared libraries the rest needs as apk "so:" names.
FROM ${REGISTRY}/library/postgres@${POSTGRES15_DIGEST} AS postgres
RUN set -euxo pipefail; \
    mkdir -p /out/usr/local/bin /out/usr/local/lib /out/usr/local/share; \
    for tool in postgres initdb pg_ctl pg_isready psql; do \
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

# The baseline's dependencies from its vendored lockfile, installed as the app's README says
# (npm ci --ignore-scripts), as an unprivileged user. The same tree serves the app and, as a
# separate root-only copy, the evaluator (pg 8.23.1 and Playwright 1.63.0).
FROM node24 AS deps
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
USER node
WORKDIR /home/node/deps
COPY --from=app --chown=node:node package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM node24 AS kit
ARG NODE24_DIGEST
ARG POSTGRES15_DIGEST

COPY --from=postgres /out/ /
# The official image's PostgreSQL reads the system time-zone database (tzdata).
RUN set -euxo pipefail; \
    xargs apk add --no-cache tini setpriv tzdata < /postgres-rundeps; \
    rm /postgres-rundeps; \
    postgres --version

RUN set -euxo pipefail; \
    addgroup -g 2001 rbw-app; \
    adduser -D -H -h /var/tmp/rbw-app -s /sbin/nologin -G rbw-app -u 2001 rbw-app; \
    addgroup -g 2002 rbw-db; \
    adduser -D -H -h /var/tmp/rbw-db -s /sbin/nologin -G rbw-db -u 2002 rbw-db

COPY --from=deps --chown=0:0 /home/node/deps/node_modules /workspace/app/node_modules
COPY --from=deps --chown=0:0 /home/node/deps/node_modules /opt/rbw/evaluator/node_modules
COPY --from=launcher --chown=0:0 --chmod=0755 rbw-launch /opt/rbw/bin/rbw-launch
COPY --chown=0:0 --chmod=0755 bin/ /opt/rbw/bin/
COPY --chown=0:0 etc/ /opt/rbw/etc/
COPY --from=evaluator --chown=0:0 package.json /opt/rbw/evaluator/pkg/package.json
COPY --from=evaluator --chown=0:0 src /opt/rbw/evaluator/pkg/src
COPY --from=evaluator --chown=0:0 data /opt/rbw/evaluator/pkg/data
COPY --from=evaluator --chown=0:0 protocol /opt/rbw/evaluator/pkg/protocol
COPY --from=evaluator --chown=0:0 baseline /opt/rbw/evaluator/pkg/baseline
COPY --from=app --chown=0:0 package.json playwright.config.ts tsconfig.json /opt/rbw/evaluator/suite/
COPY --from=app --chown=0:0 test /opt/rbw/evaluator/suite/test

# Ownership and modes. The evaluator tree and the results are root-only. The app tree is
# root-owned and read-only to rbw-app. rbw-db writes only its home and each instance's database
# directory; rbw-app writes only its home. /tmp and /var/tmp are not writable by either. No file
# keeps a setuid or setgid bit.
RUN set -euxo pipefail; \
    chmod 0755 /opt/rbw /opt/rbw/bin /opt/rbw/etc /opt/rbw/etc/provision; \
    find /opt/rbw/etc -type f -exec chmod 0644 {} +; \
    chown -R root:root /opt/rbw/evaluator; \
    find /opt/rbw/evaluator -type d -exec chmod 0700 {} +; \
    find /opt/rbw/evaluator -type f -perm /111 -exec chmod 0700 {} +; \
    find /opt/rbw/evaluator -type f ! -perm /111 -exec chmod 0600 {} +; \
    install -d -o root -g root -m 0755 /var/lib/rbw /var/lib/rbw/instances; \
    install -d -o root -g root -m 0700 /var/lib/rbw/results; \
    install -d -o root -g rbw-db -m 0770 /run/rbw-pg; \
    install -d -o rbw-db -g rbw-db -m 0700 /var/tmp/rbw-db; \
    install -d -o rbw-app -g rbw-app -m 0700 /var/tmp/rbw-app; \
    chmod 0755 /tmp /var/tmp; \
    chmod -R u=rwX,go=rX /workspace; \
    find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod ug-s {} +; \
    printf '{"node24_digest":"%s","postgres15_digest":"%s","node":"%s","postgres":"%s"}\n' \
      "$NODE24_DIGEST" "$POSTGRES15_DIGEST" "$(node --version)" "$(postgres --version)" > /opt/rbw/evaluator/image.json; \
    chmod 0600 /opt/rbw/evaluator/image.json

WORKDIR /workspace/app
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/opt/rbw/bin/rbw-copy"]
