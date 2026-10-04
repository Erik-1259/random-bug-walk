#!/bin/bash
# Image entrypoint. When OPENAI_API_KEY is set, signs Codex in with it on every start
# (Codex does not read the key from the environment by itself), replacing any earlier
# sign-in kept in a state volume, then runs the command.
set -euo pipefail

if [ -n "${OPENAI_API_KEY:-}" ]; then
  if ! printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1; then
    echo "entrypoint: Codex sign-in with OPENAI_API_KEY failed" >&2
  fi
fi

exec "$@"
