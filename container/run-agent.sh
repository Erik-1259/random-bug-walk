#!/bin/bash
# Starts a coding-agent container. The only host paths it can reach are one
# standalone git working copy (/workspace) and one inbox directory (/inbox).
set -euo pipefail

readonly DEFAULT_IMAGE="rbw-dev:local"
readonly AGENT_HOSTNAME="rbw-agent"
readonly NAME_PREFIX="rbw-agent-"
readonly CREDENTIAL_NAMES="ANTHROPIC_API_KEY OPENAI_API_KEY"
readonly NL=$'\n'
readonly CR=$'\r'

usage() {
  cat <<'EOF'
Usage: run-agent.sh --worktree DIR --inbox DIR [--credentials FILE] [--name NAME]
                    [--image IMAGE] [--state-volume VOLUME] [--print-args]
                    [-- COMMAND [ARGS...]]

Runs COMMAND (default: an interactive bash shell) in a container whose only
host mounts are the two below, plus the inbox's publication/ directory again,
read-only, with its requests/ directory read-write:
  --worktree DIR         a standalone git repository, read-write at /workspace;
                         create it with: git clone --no-hardlinks SOURCE DIR
  --inbox DIR            the shared inbox directory, read-write at /inbox

Options:
  --credentials FILE     NAME=value lines for ANTHROPIC_API_KEY and OPENAI_API_KEY,
                         one per line; other names are refused, empty values are
                         skipped; the file must be readable by its owner only and
                         lie outside the worktree and the inbox
  --name NAME            container name suffix (default: worktree folder name)
  --image IMAGE          local image to run (default: rbw-dev:local)
  --state-volume VOLUME  named Docker volume mounted at /home/node so agent
                         sign-in state persists between runs; use one volume
                         per worktree (default: none)
  --print-args           print the arguments that follow `docker`, one per
                         line, and exit without running anything

Environment passed in: GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME
and GIT_COMMITTER_EMAIL from the worktree's own .git/config (required), plus
the non-empty keys from --credentials. Nothing else, and nothing from the
caller's environment.

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
name=""
image="$DEFAULT_IMAGE"
state_volume=""
print_args=0
command_args=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --worktree | --inbox | --credentials | --name | --image | --state-volume)
      [ "$#" -ge 2 ] || die "$1 needs a value"
      case "$1" in
        --worktree) worktree=$2 ;;
        --inbox) inbox=$2 ;;
        --credentials) credentials=$2 ;;
        --name) name=$2 ;;
        --image) image=$2 ;;
        --state-volume) state_volume=$2 ;;
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

if [ -n "$state_volume" ]; then
  case "$state_volume" in
    */*) die "--state-volume takes a Docker volume name, not a path" ;;
    [![:alnum:]]* | *[!-[:alnum:]_.]*) die "--state-volume is not a valid Docker volume name" ;;
  esac
  if command -v docker >/dev/null 2>&1; then
    # A local volume created with driver options can be backed by a host
    # directory. A volume that does not exist yet is created plain.
    if docker volume inspect "$state_volume" >/dev/null 2>&1; then
      case "$(docker volume inspect --format '{{.Driver}} {{len .Options}}' "$state_volume" 2>/dev/null || true)" in
        "local 0") ;;
        *) die "--state-volume must be a plain local Docker volume" ;;
      esac
    fi
    # Files in /home/node can run in the next container that mounts the volume.
    if [ -n "$(docker ps --quiet --filter "volume=$state_volume" 2>/dev/null || true)" ]; then
      die "--state-volume is in use by another container"
    fi
  fi
fi

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
for var in $CREDENTIAL_NAMES; do
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
if [ -n "$state_volume" ]; then
  docker_args+=(--mount "type=volume,source=$state_volume,target=/home/node")
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
exec docker "${docker_args[@]}"
