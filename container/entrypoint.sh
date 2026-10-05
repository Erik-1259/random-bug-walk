#!/bin/bash
# Image entrypoint. When run-agent.sh mounts a copy of the owner's ChatGPT sign-in
# (--codex-auth), installs it for Codex in the container's home, then runs the
# command. The installed copy goes away with the container; the host file is never
# written. Claude Code reads CLAUDE_CODE_OAUTH_TOKEN from the environment by itself.
set -euo pipefail

readonly CODEX_SEED=/run/codex-seed/auth.json

if [ -f "$CODEX_SEED" ]; then
  mkdir -p "$HOME/.codex"
  install -m 0600 "$CODEX_SEED" "$HOME/.codex/auth.json"
fi

exec "$@"
