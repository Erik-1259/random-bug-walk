#!/bin/bash
# Image entrypoint. When OPENAI_API_KEY is set, signs Codex in with it (Codex does
# not read the key from the environment by itself), then runs the command. The
# sign-in file lives in the container's home and goes away with the container.
set -euo pipefail

if [ -n "${OPENAI_API_KEY:-}" ] && ! codex login status >/dev/null 2>&1; then
  if ! printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1; then
    echo "entrypoint: Codex sign-in with OPENAI_API_KEY failed" >&2
  fi
fi

exec "$@"
