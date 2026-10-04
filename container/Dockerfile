# Development container for coding agents (Claude Code and Codex CLIs) working on a
# TypeScript/Node + Python (uv) project. Start it only through run-agent.sh.
FROM node:24.21.0-trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        jq \
        less \
        openssh-client \
        procps \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Static uv and uvx binaries. No Python is baked in; uv provisions it per project.
COPY --from=ghcr.io/astral-sh/uv:0.12.22 /uv /uvx /usr/local/bin/

# DISABLE_AUTOUPDATER and DISABLE_UPDATES: Claude Code never updates itself.
# GIT_TERMINAL_PROMPT=0: git fails instead of asking for credentials.
# UV_LINK_MODE=copy: /workspace is a bind mount, so uv cannot hardlink from its cache.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1 \
    GIT_TERMINAL_PROMPT=0 \
    UV_LINK_MODE=copy

RUN npm install --global --no-audit --no-fund \
        pnpm@10.33.2 \
        @anthropic-ai/claude-code@2.1.287 \
        @openai/codex@0.160.0 \
    && npm cache clean --force \
    && pnpm --version \
    && uv --version \
    && claude --version \
    && codex --version

# System-level config, so it still applies when a state volume is mounted at /home/node.
# The container is the sandbox: Codex's own Linux sandbox needs user namespaces or a
# setuid bwrap, and Docker's default seccomp profile and no-new-privileges rule out both.
RUN mkdir -p /etc/codex /workspace /inbox \
    && printf 'check_for_update_on_startup = false\nsandbox_mode = "danger-full-access"\n' > /etc/codex/config.toml \
    && git config --system --add safe.directory /workspace \
    && chown node:node /workspace /inbox

COPY --chmod=0755 entrypoint.sh /usr/local/bin/rbw-entrypoint

USER node
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/rbw-entrypoint"]
CMD ["bash"]
