#!/usr/bin/env bash
# Builds the factory worker image (linux/amd64) from one repository commit and the prepared catalog
# packages. It pushes and uploads nothing; README.md lists the conductor's push and upload commands.
#
#   kit/factory-worker/build.sh <commit> <prepared directory> <image tag>
#
# The build context is a new temporary directory holding `git archive <commit>` and a copy of the
# prepared directory, so nothing uncommitted enters the image. The Dockerfile used is the one in
# that commit. Exit codes: 0 built; 1 the build failed; 2 a usage or input error.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: kit/factory-worker/build.sh <commit> <prepared directory> <image tag>" >&2
  exit 2
fi
commit="$1"
prepared="$2"
tag="$3"

root="$(git rev-parse --show-toplevel)"
if ! resolved="$(git -C "$root" rev-parse --verify --quiet "${commit}^{commit}")"; then
  echo "not a commit: $commit" >&2
  exit 2
fi
if [ ! -d "$prepared" ]; then
  echo "not a directory: $prepared" >&2
  exit 2
fi
if ! git -C "$root" cat-file -e "${resolved}:kit/factory-worker/Dockerfile" 2>/dev/null; then
  echo "commit $resolved has no kit/factory-worker/Dockerfile" >&2
  exit 2
fi

context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT
mkdir "$context/repo" "$context/factory-packages"
git -C "$root" archive --format=tar "$resolved" | tar -x -C "$context/repo"
# Flat and regular files only; the Dockerfile checks each name against its sha256.
find "$prepared" -mindepth 1 -maxdepth 1 -type f -exec cp {} "$context/factory-packages/" \;
if [ -n "$(find "$prepared" -mindepth 1 ! -type f -print -quit)" ]; then
  echo "the prepared directory must hold regular files only" >&2
  exit 2
fi

docker build --platform linux/amd64 \
  --label "org.opencontainers.image.revision=$resolved" \
  -f "$context/repo/kit/factory-worker/Dockerfile" \
  -t "$tag" \
  "$context"
echo "built $tag from $resolved"
