#!/bin/bash
# Starts a coding-agent container. The only host paths it can reach are one
# standalone git working copy (/workspace) and one inbox directory (/inbox).
set -euo pipefail

readonly DEFAULT_IMAGE="rbw-dev:local"
readonly AGENT_HOSTNAME="rbw-agent"
readonly NAME_PREFIX="rbw-agent-"
# Local agents run on the owner's subscriptions. The API keys may sit in the same
# file for other uses; they are read past and never passed into a container.
readonly CREDENTIAL_NAMES="CLAUDE_CODE_OAUTH_TOKEN"
readonly IGNORED_CREDENTIAL_NAMES="ANTHROPIC_API_KEY OPENAI_API_KEY"
readonly CODEX_LOCK="${TMPDIR:-/tmp}/rbw-codex-auth.lock"
readonly NL=$'\n'
readonly CR=$'\r'

usage() {
  cat <<'EOF'
Usage: run-agent.sh --worktree DIR --inbox DIR [--credentials FILE] [--codex-auth FILE]
                    [--name NAME] [--image IMAGE] [--print-args]
                    [-- COMMAND [ARGS...]]

Runs COMMAND (default: an interactive bash shell) in a container whose only
host mounts are the two below, plus the inbox's publication/ directory again,
read-only, with its requests/ directory read-write:
  --worktree DIR         a standalone git repository, read-write at /workspace;
                         create it with: git clone --no-hardlinks SOURCE DIR
  --inbox DIR            the shared inbox directory, read-write at /inbox

Options:
  --credentials FILE     NAME=value lines; CLAUDE_CODE_OAUTH_TOKEN (from
                         `claude setup-token`) is passed in; ANTHROPIC_API_KEY and
                         OPENAI_API_KEY lines are skipped and never passed in; other
                         names are refused, empty values are skipped; the file must
                         be readable by its owner only and lie outside the worktree
                         and the inbox
  --codex-auth FILE      a ChatGPT sign-in file (~/.codex/auth.json, owner-only); the
                         run gets a private writable copy at /run/codex-state
                         (CODEX_HOME); if Codex refreshes it, the refreshed sign-in
                         is written back to FILE, then the copy is deleted; one such
                         run at a time, because Codex must not share a sign-in file
                         across concurrent runs
  --name NAME            container name suffix (default: worktree folder name)
  --image IMAGE          local image to run (default: rbw-dev:local)
  --print-args           print the arguments that follow `docker`, one per
                         line, and exit without running anything

Environment passed in: GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME
and GIT_COMMITTER_EMAIL from the worktree's own .git/config (required), plus
CLAUDE_CODE_OAUTH_TOKEN from --credentials. No API key, nothing else, and
nothing from the caller's environment.

The container can reach services listening on this machine through
host.docker.internal; stop local databases or require passwords on them
while agents run.

After a run, treat the worktree as untrusted: the agent can write .git/config
and .git/hooks, and git on this machine runs the programs they name. Apart
from this script, which only reads its git config, do not run git, a
git-aware shell prompt, an editor or a package manager inside it. Bring
commits back from another clone with:
  git -C OTHER_CLONE fetch WORKTREE BRANCH
EOF
}

die() {
  printf 'run-agent.sh: %s\n' "$1" >&2
  exit 2
}

# Absolute physical path of an existing directory; works without realpath.
physical_dir() {
  (CDPATH='' cd -P -- "$1" 2>/dev/null && pwd -P)
}

lowercase() {
  printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]'
}

# True when path $1 is path $2 or lies below it.
inside_or_same() {
  case "$1/" in
    "$2/"*) return 0 ;;
  esac
  return 1
}

# After a --codex-auth run: when the run refreshed the sign-in, replace the host
# file with the refreshed one, so neither the owner nor the next run is left with
# a spent refresh token. Only a regular file for the same account is accepted, and
# only if the host file did not change during the run. Prints no token.
write_back_codex_auth() {
  local refreshed="$codex_seed_dir/auth.json" account tmp
  [ -f "$refreshed" ] && [ ! -L "$refreshed" ] || return 0
  if cmp -s "$refreshed" "$codex_auth_path"; then
    return 0
  fi
  account=$(jq -r '.tokens.account_id // empty' "$codex_auth_path" 2>/dev/null || true)
  if [ -z "$account" ] ||
    ! jq -e --arg a "$account" '.tokens.account_id == $a and (.tokens.refresh_token | type == "string")' "$refreshed" >/dev/null 2>&1; then
    printf 'run-agent.sh: the run left a Codex sign-in that is not a refresh of --codex-auth; ignored it\n' >&2
    return 0
  fi
  if [ "$(shasum -a 256 "$codex_auth_path" | cut -d' ' -f1)" != "$codex_auth_hash" ]; then
    printf 'run-agent.sh: --codex-auth changed during the run; kept it and dropped the run'"'"'s refreshed copy\n' >&2
    return 0
  fi
  tmp=$(mktemp "$codex_auth_dir/.auth.json.XXXXXX")
  chmod 600 "$tmp"
  cat "$refreshed" >"$tmp"
  mv -f "$tmp" "$codex_auth_path"
  printf 'run-agent.sh: wrote the refreshed Codex sign-in back to --codex-auth\n' >&2
}

# True when either path is the other or lies below it. Compared without case,
# because macOS volumes are usually case-insensitive.
overlap() {
  local a b
  a=$(lowercase "$1")
  b=$(lowercase "$2")
  inside_or_same "$a" "$b" || inside_or_same "$b" "$a"
}

# Refuses directories that must never be mounted or cannot be written in --mount.
check_mount_dir() {
  case "$2" in
    /) die "$1 must not be the filesystem root" ;;
    *,* | *\"* | *"$NL"*) die "$1 path must not contain commas, double quotes or newlines" ;;
  esac
  if [ -n "$home_dir" ] && inside_or_same "$(lowercase "$home_dir")" "$(lowercase "$2")"; then
    die "$1 must not be your home directory or one of its parents"
  fi
}

worktree=""
inbox=""
credentials=""
codex_auth=""
name=""
image="$DEFAULT_IMAGE"
print_args=0
command_args=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --worktree | --inbox | --credentials | --codex-auth | --name | --image)
      [ "$#" -ge 2 ] || die "$1 needs a value"
      case "$1" in
        --worktree) worktree=$2 ;;
        --inbox) inbox=$2 ;;
        --credentials) credentials=$2 ;;
        --codex-auth) codex_auth=$2 ;;
        --name) name=$2 ;;
        --image) image=$2 ;;
      esac
      shift 2
      ;;
    --print-args)
      print_args=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      command_args=("$@")
      break
      ;;
    *)
      die "unknown argument; see --help"
      ;;
  esac
done

[ -n "$worktree" ] || die "--worktree is required"
[ -n "$inbox" ] || die "--inbox is required"
[ -d "$worktree" ] || die "--worktree is not an existing directory"
[ -d "$inbox" ] || die "--inbox is not an existing directory"
worktree_dir=$(physical_dir "$worktree") || die "cannot resolve --worktree"
inbox_dir=$(physical_dir "$inbox") || die "cannot resolve --inbox"

home_dir=""
if [ -n "${HOME:-}" ] && [ -d "$HOME" ]; then
  home_dir=$(physical_dir "$HOME") || home_dir=""
fi

check_mount_dir --worktree "$worktree_dir"
check_mount_dir --inbox "$inbox_dir"
if overlap "$worktree_dir" "$inbox_dir"; then
  die "--worktree and --inbox must be different directories, neither inside the other"
fi

command -v git >/dev/null 2>&1 || die "git is not on PATH"

# The working copy must be self-contained. A linked worktree, a commondir file
# or a borrowed object store points into another repository, which would need
# another mount. A hard-linked file is shared with another path: a plain local
# clone hard-links its objects to the source repository.
git_dir="$worktree_dir/.git"
if [ -L "$git_dir" ]; then
  die "--worktree/.git must be a directory, not a symlink"
elif [ -f "$git_dir" ]; then
  die "--worktree is a linked git worktree (.git is a file); use a standalone clone"
elif [ ! -d "$git_dir" ] || [ ! -f "$git_dir/HEAD" ]; then
  die "--worktree must be a git repository with its own .git directory"
elif [ -e "$git_dir/commondir" ] || [ -L "$git_dir/commondir" ]; then
  die "--worktree/.git points into another repository (commondir); use a standalone clone"
elif [ -s "$git_dir/objects/info/alternates" ]; then
  die "--worktree borrows objects from another repository (alternates); use a standalone clone"
elif [ -n "$(find "$git_dir" -type f -links +1 -print -quit 2>/dev/null)" ]; then
  die "--worktree shares hard-linked files with another repository; clone with git clone --no-hardlinks"
fi

# Credentials in the working copy's own git config would be mounted with it:
# credential settings, extra HTTP headers, ssh or askpass commands, and URLs
# with a user name or token. Values are never printed.
git_config=$(git config --file "$git_dir/config" --list 2>/dev/null) ||
  die "cannot read --worktree/.git/config"
if grep -Eqi '^(credential\..*|http\.(.*\.)?extraheader|core\.(sshcommand|askpass))=|https?://[^/@[:space:]]+@' <<<"$git_config"; then
  die "--worktree/.git/config holds a credential setting, extra HTTP header, ssh or askpass command, or URL with a user name or token; remove it first"
fi

case "$image" in
  "" | -* | *[!-[:alnum:]._/:@]*) die "--image is not a valid image reference" ;;
esac

[ -n "$name" ] || name=${worktree_dir##*/}
safe_name=$(printf '%s' "$name" |
  LC_ALL=C tr '[:upper:]' '[:lower:]' |
  LC_ALL=C tr -c 'a-z0-9-' '-' |
  tr -s '-' |
  cut -c 1-40 |
  sed -e 's/^-*//' -e 's/-*$//')
[ -n "$safe_name" ] || safe_name="agent"
container_name="$NAME_PREFIX$safe_name"

# The commit identity comes only from the working copy's own .git/config, never
# from the caller's global config, so each working copy states its identity.
# Values are exported and passed with -e NAME, so they never appear in docker's
# argument list.
env_names=()
git_name=$(git config --file "$git_dir/config" --get user.name 2>/dev/null || true)
git_email=$(git config --file "$git_dir/config" --get user.email 2>/dev/null || true)
if [ -z "$git_name" ] || [ -z "$git_email" ]; then
  die "set user.name and user.email in the worktree's own git config (git config --local)"
fi
export GIT_AUTHOR_NAME="$git_name" GIT_COMMITTER_NAME="$git_name"
export GIT_AUTHOR_EMAIL="$git_email" GIT_COMMITTER_EMAIL="$git_email"
env_names+=(GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL)

# Keys come only from --credentials, never from the caller's environment.
for var in $CREDENTIAL_NAMES $IGNORED_CREDENTIAL_NAMES; do
  unset "$var"
done
if [ -n "$credentials" ]; then
  if [ ! -f "$credentials" ] || [ -L "$credentials" ]; then
    die "--credentials must be an existing regular file, not a symlink"
  fi
  credentials_dir=$(physical_dir "$(dirname -- "$credentials")") || die "cannot resolve --credentials"
  credentials_path="$credentials_dir/${credentials##*/}"
  for dir in "$worktree_dir" "$inbox_dir"; do
    if inside_or_same "$(lowercase "$credentials_path")" "$(lowercase "$dir")"; then
      die "--credentials must lie outside the worktree and the inbox"
    fi
  done
  mode=$(stat -f '%Lp' "$credentials_path" 2>/dev/null || stat -c '%a' "$credentials_path" 2>/dev/null) ||
    die "cannot read the permissions of --credentials"
  case "$mode" in
    600 | 400) ;;
    *) die "--credentials must be readable by its owner only (chmod 600)" ;;
  esac
  # Messages name the line number only, never its text.
  line_no=0
  while IFS= read -r line || [ -n "$line" ]; do
    line_no=$((line_no + 1))
    line=${line%"$CR"}
    case "$line" in
      "" | "#"*) continue ;;
    esac
    key=${line%%=*}
    [ "$key" != "$line" ] || die "--credentials line $line_no is not NAME=value"
    case " $IGNORED_CREDENTIAL_NAMES " in
      *" $key "*) continue ;;
    esac
    case " $CREDENTIAL_NAMES " in
      *" $key "*) ;;
      *) die "--credentials line $line_no names a variable that is not accepted" ;;
    esac
    value=${line#*=}
    [ -n "$value" ] || continue
    export "$key=$value"
    env_names+=("$key")
  done <"$credentials_path"
fi

# The Codex sign-in is copied, not mounted: Codex refreshes the file in place, and
# concurrent runs must not share one. The copy lives in a private directory outside
# the worktree and inbox, is mounted read-only, and is removed when the run ends.
codex_seed_dir=""
if [ -n "$codex_auth" ]; then
  if [ ! -f "$codex_auth" ] || [ -L "$codex_auth" ]; then
    die "--codex-auth must be an existing regular file, not a symlink"
  fi
  codex_auth_dir=$(physical_dir "$(dirname -- "$codex_auth")") || die "cannot resolve --codex-auth"
  codex_auth_path="$codex_auth_dir/${codex_auth##*/}"
  for dir in "$worktree_dir" "$inbox_dir"; do
    if inside_or_same "$(lowercase "$codex_auth_path")" "$(lowercase "$dir")"; then
      die "--codex-auth must lie outside the worktree and the inbox"
    fi
  done
  mode=$(stat -f '%Lp' "$codex_auth_path" 2>/dev/null || stat -c '%a' "$codex_auth_path" 2>/dev/null) ||
    die "cannot read the permissions of --codex-auth"
  case "$mode" in
    600 | 400) ;;
    *) die "--codex-auth must be readable by its owner only (chmod 600)" ;;
  esac
fi

# The publication request area is mounted separately: inbox/publication read-only
# and its requests/ directory read-write. Mount points cannot be renamed or
# replaced from inside the container, so an agent cannot swap these directories
# for symlinks that the host-side helper would then follow.
publication_dir="$inbox_dir/publication"
for dir in "$publication_dir" "$publication_dir/requests" "$publication_dir/responses"; do
  if [ -L "$dir" ]; then
    die "inbox publication directories must be real directories, not symlinks"
  fi
  if [ ! -d "$dir" ]; then
    mkdir -m 755 "$dir" || die "cannot create the inbox publication directories"
  fi
done

docker_args=(
  run
  --rm
  --init
  --interactive
  --pull never
  --name "$container_name"
  --hostname "$AGENT_HOSTNAME"
  --network bridge
  --security-opt no-new-privileges
  --cap-drop ALL
  --mount "type=bind,source=$worktree_dir,target=/workspace"
  --mount "type=bind,source=$inbox_dir,target=/inbox"
  --mount "type=bind,source=$publication_dir,target=/inbox/publication,readonly"
  --mount "type=bind,source=$publication_dir/requests,target=/inbox/publication/requests"
)
if [ -t 0 ] && [ -t 1 ]; then
  docker_args+=(--tty)
fi
if [ -n "$codex_auth" ]; then
  if [ "$print_args" -eq 1 ]; then
    codex_seed_dir="<private copy of --codex-auth>"
  else
    mkdir "$CODEX_LOCK" 2>/dev/null ||
      die "another --codex-auth run is active; if none is, remove $CODEX_LOCK"
    codex_lock_held=1
    trap '[ -z "$codex_seed_dir" ] || rm -rf "$codex_seed_dir"; [ -z "${codex_lock_held:-}" ] || rmdir "$CODEX_LOCK"' EXIT
    codex_seed_dir=$(mktemp -d "${TMPDIR:-/tmp}/rbw-codex-seed.XXXXXX")
    # Codex refreshes the sign-in in place and the old refresh token stops working,
    # so the run gets its own writable copy, and a refreshed copy is written back
    # to --codex-auth after the run (see write_back_codex_auth).
    install -m 0644 "$codex_auth_path" "$codex_seed_dir/auth.json"
    codex_auth_hash=$(shasum -a 256 "$codex_auth_path" | cut -d' ' -f1)
  fi
  docker_args+=(--mount "type=bind,source=$codex_seed_dir,target=/run/codex-state")
  export CODEX_HOME=/run/codex-state
  env_names+=(CODEX_HOME)
fi
for var in ${env_names[@]+"${env_names[@]}"}; do
  docker_args+=(-e "$var")
done
docker_args+=("$image")
if [ "${#command_args[@]}" -gt 0 ]; then
  docker_args+=("${command_args[@]}")
else
  docker_args+=(bash)
fi

if [ "$print_args" -eq 1 ]; then
  printf '%s\n' "${docker_args[@]}"
  exit 0
fi

command -v docker >/dev/null 2>&1 || die "docker is not on PATH"
if [ -z "$codex_auth" ]; then
  exec docker "${docker_args[@]}"
fi
# Not exec: the sign-in copy and the lock are removed when docker returns. If this
# script is told to stop, it stops the container first, so the lock is never
# released while a container still holds a copy of the sign-in.
docker "${docker_args[@]}" <&0 &
docker_pid=$!
# Signal the docker client too: it forwards the signal to the container, and it is
# there even before docker has created the container, when stop would find nothing.
trap 'kill -TERM "$docker_pid" 2>/dev/null || true; docker stop --time 10 "$container_name" >/dev/null 2>&1 || true' TERM INT HUP
status=0
wait "$docker_pid" || status=$?
# A trapped signal interrupts the first wait; wait again for docker to finish.
while kill -0 "$docker_pid" 2>/dev/null; do
  status=0
  wait "$docker_pid" || status=$?
done
write_back_codex_auth
exit "$status"
