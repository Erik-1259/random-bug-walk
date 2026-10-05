#!/bin/bash
# Image entrypoint. Runs the command. For a --codex-auth run, run-agent.sh mounts a
# private writable copy of the owner's ChatGPT sign-in at /run/codex-state and sets
# CODEX_HOME to it, so Codex reads and refreshes that copy; the launcher writes a
# refreshed copy back afterwards. Claude Code reads CLAUDE_CODE_OAUTH_TOKEN from the
# environment by itself.
set -euo pipefail

exec "$@"
