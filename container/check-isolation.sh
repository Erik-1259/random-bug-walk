#!/bin/bash
# Integration proof for run-agent.sh. Starts a check container with the docker
# arguments printed by run-agent.sh --print-args and prints one PASS/FAIL line
# per check. Output holds names, counts and one-line reasons only: never secret
# values or file contents.
set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -P -- "$(dirname -- "$0")" && pwd -P)
readonly LAUNCHER="$SCRIPT_DIR/run-agent.sh"
readonly ALLOWED_ENV=" ANTHROPIC_API_KEY OPENAI_API_KEY GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL "
# Throwaway host-key settings for this test only, so an SSH attempt reaches
# GitHub's authentication step instead of stopping at host-key verification.
readonly SSH_TEST_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=20"
# Default ports of PostgreSQL, MySQL, Redis and MongoDB.
readonly DB_PORTS="5432 3306 6379 27017"
readonly NL=$'\n'
readonly CR=$'\r'
readonly SEP=$'\037'

readonly MOUNTS_FORMAT="{{range .Mounts}}{{.Type}}$SEP{{.Name}}$SEP{{.Source}}$SEP{{.Destination}}$SEP{{.RW}}{{println}}{{end}}"
readonly HARDENING_FORMAT='{{.HostConfig.Privileged}}|{{.HostConfig.NetworkMode}}|{{len .HostConfig.PortBindings}}|{{len .HostConfig.Devices}}|{{.HostConfig.CapDrop}}|{{.HostConfig.SecurityOpt}}|{{.HostConfig.PidMode}}|{{.HostConfig.IpcMode}}'

# The scripts below run inside the container as the image's user.
readonly PROBE_SCRIPT='
for p in "$1" "$2"; do
  if [ -e "$p" ] || [ -L "$p" ]; then
    if n=$(wc -c < "$p" 2>/dev/null); then
      echo "readable $((n))"
    else
      echo "present"
    fi
    exit 0
  fi
done
found=$(timeout 300 find / \( -path /proc -o -path /sys \) -prune -o -name "$3" -print 2>/dev/null) || status=$?
case "${status:-0}" in
  0 | 1) echo "absent $(printf "%s" "$found" | grep -c . || true)" ;;
  124) echo "timeout" ;;
  *) echo "error" ;;
esac
'
readonly PUSH_REPO_SCRIPT='
set -e
d=$(mktemp -d /tmp/push-probe.XXXXXX)
git -C "$d" -c init.defaultBranch=probe init -q
GIT_AUTHOR_NAME=isolation-check GIT_AUTHOR_EMAIL=isolation-check@example.invalid \
GIT_COMMITTER_NAME=isolation-check GIT_COMMITTER_EMAIL=isolation-check@example.invalid \
  git -C "$d" commit -q --allow-empty -m "isolation probe"
echo "$d"
'
readonly ENV_SCRIPT='compgen -e | grep -iE "TOKEN|KEY|SECRET|PASS|GITHUB|GH_|VERCEL|NEON|BLOB|DATABASE|PG|AWS|NPM" || true'
# Runs from /workspace, so system, user and repository git config all apply.
# Prints git key names only, with any URL part replaced by <url>.
readonly FILES_SCRIPT='
for p in "$HOME/.ssh" "$HOME/.config/gh" "$HOME/.git-credentials" "$HOME/.netrc" "$HOME/.vercel" \
  "$HOME/.docker/config.json" /var/run/docker.sock /run/docker.sock; do
  if [ -e "$p" ] || [ -L "$p" ]; then echo "$p"; fi
done
if [ -n "${SSH_AUTH_SOCK:-}" ]; then echo "SSH_AUTH_SOCK"; fi
git config --name-only --get-regexp "^(credential\.(.*\.)?helper|http\.(.*\.)?extraheader|core\.(sshcommand|askpass))$" 2>/dev/null |
  sed -E "s/^([^.]+)\..*\.([^.]+)$/\1.<url>.\2/" || true
if git config --get-regexp ".*" 2>/dev/null | grep -Eqi "https?://[^/@[:space:]]+@"; then echo "git URL with credentials"; fi
'
# Tries to tamper with the publication area from inside the container. Prints one
# line per attempt that succeeded; an empty output means every attempt failed.
readonly PUBLICATION_SCRIPT='
if mv /inbox/publication /inbox/publication-moved 2>/dev/null; then echo "renamed publication"; mv /inbox/publication-moved /inbox/publication 2>/dev/null; fi
if mv /inbox/publication/requests /inbox/publication/requests-moved 2>/dev/null; then echo "renamed requests"; fi
if touch /inbox/publication/responses/.probe 2>/dev/null; then echo "wrote into responses"; rm -f /inbox/publication/responses/.probe; fi
if ln -s / /inbox/publication/link-probe 2>/dev/null; then echo "created a link in publication"; rm -f /inbox/publication/link-probe; fi
p=/inbox/publication/requests/.probe-$$
if ! { touch "$p" 2>/dev/null && rm -f "$p"; }; then echo "requests not writable"; fi
'
readonly VERSIONS_SCRIPT='
for tool in node pnpm uv git claude codex; do
  v=$("$tool" --version 2>/dev/null | head -n 1)
  echo "$tool=${v:-missing}"
done
'
readonly HOST_PORTS_SCRIPT='
for p in $1; do
  if timeout 3 bash -c "</dev/tcp/host.docker.internal/$p" 2>/dev/null; then echo "$p"; fi
done
'

usage() {
  cat <<'EOF'
Usage: check-isolation.sh --worktree DIR --inbox DIR --probe FILE
                          --private-remote OWNER/REPO [--image IMAGE]
                          [--state-volume VOLUME] [--expose]

Starts a check container with run-agent.sh's docker arguments and verifies:
  a.  the probe file cannot be read and no file with its name is visible
  b1. the only host mounts are the worktree and the inbox, plus the inbox's
      publication/ directory read-only with its requests/ read-write
  h.  the publication area cannot be renamed or replaced, responses/ is
      read-only and requests/ is writable
  b2. the hardening flags are in effect
  c0. control: the repository exists, is private, and this machine can read it
      with its own credentials (GitHub CLI if signed in, else git ls-remote,
      which may show a keychain prompt)
  c1-c4. git in the container cannot read or push to it over SSH or HTTPS;
      the pushes run only if both reads failed at authentication
  d.  no credential-like environment variables beyond the allowlist
  e.  no credential files, sockets, git credential settings or ssh commands
  f.  tool versions
  g.  note only: which database ports on this machine answer through
      host.docker.internal

  --probe FILE       absolute path of an existing file outside the worktree and
                     inbox that agents must not read; give it a distinctive name
  --private-remote   a private GitHub repository (reading it needs credentials)
  --state-volume     also mount this named state volume, as run-agent.sh would
  --expose           control run: adds one read-only bind mount of the probe's
                     directory and exits 0 only if checks a and b1 then fail
EOF
}

die() {
  printf 'check-isolation.sh: %s\n' "$1" >&2
  exit 2
}

passed=0
failed=0
last=""
last_text=""
pass() {
  printf 'PASS  %s\n' "$1"
  passed=$((passed + 1))
  last=pass
  last_text=$1
}
fail() {
  printf 'FAIL  %s\n' "$1"
  failed=$((failed + 1))
  last=fail
  last_text=$1
}
# Information that does not decide the result.
note() {
  printf 'NOTE  %s\n' "$1"
}

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

# Docker Desktop may report bind sources with a /host_mnt prefix.
same_source() {
  [ "$1" = "$2" ] || [ "$1" = "/host_mnt$2" ]
}

# A local volume created with driver options can be backed by a host directory.
plain_volume() {
  [ "$(docker volume inspect --format '{{.Driver}} {{len .Options}}' "$1" </dev/null 2>/dev/null || true)" = "local 0" ]
}

# One printable line: no carriage returns, no repository name, at most 160 chars.
clean() {
  local s=$1
  s=${s//$CR/}
  if [ -n "$remote" ]; then
    s=${s//"$remote"/<private-remote>}
  fi
  printf '%s' "${s:0:160}"
}

# First line that names a cause; git and ssh end with generic advice lines.
first_reason() {
  local line
  while IFS= read -r line; do
    line=${line%"$CR"}
    case "$line" in
      "" | "Warning: Permanently added"*) ;;
      *)
        printf '%s' "$line"
        return
        ;;
    esac
  done <<EOF
$1
EOF
}

worktree=""
inbox=""
probe=""
remote=""
image="rbw-dev:local"
state_volume=""
expose=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --worktree | --inbox | --probe | --private-remote | --image | --state-volume)
      [ "$#" -ge 2 ] || die "$1 needs a value"
      case "$1" in
        --worktree) worktree=$2 ;;
        --inbox) inbox=$2 ;;
        --probe) probe=$2 ;;
        --private-remote) remote=$2 ;;
        --image) image=$2 ;;
        --state-volume) state_volume=$2 ;;
      esac
      shift 2
      ;;
    --expose)
      expose=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument; see --help"
      ;;
  esac
done

[ -n "$worktree" ] || die "--worktree is required"
[ -n "$inbox" ] || die "--inbox is required"
[ -n "$probe" ] || die "--probe is required"
if [ "$expose" -eq 0 ] && [ -z "$remote" ]; then
  die "--private-remote is required"
fi
if [ -n "$remote" ]; then
  remote=${remote%.git}
  case "$remote" in
    */*/* | /* | */ | *[!-[:alnum:]_./]*) die "--private-remote must look like OWNER/REPO" ;;
    ?*/?*) ;;
    *) die "--private-remote must look like OWNER/REPO" ;;
  esac
fi

case "$probe" in
  /*) ;;
  *) die "--probe must be an absolute path" ;;
esac
if [ ! -f "$probe" ] || [ -L "$probe" ]; then
  die "--probe must be an existing regular file, not a symlink"
fi
probe_name=${probe##*/}
case "$probe_name" in
  *[][*?\\]*) die "--probe file name must not contain wildcard characters" ;;
esac
probe_parent=${probe%/*}
[ -n "$probe_parent" ] || die "--probe must not sit directly in /"
probe_dir=$(physical_dir "$probe_parent") || die "cannot resolve the directory of --probe"
[ "$probe_dir" != / ] || die "--probe must not sit directly in /"
case "$probe_dir" in
  *,* | *\"* | *"$NL"*) die "--probe path must not contain commas, double quotes or newlines" ;;
esac
probe_path="$probe_dir/$probe_name"

worktree_dir=$(physical_dir "$worktree") || die "--worktree is not an existing directory"
inbox_dir=$(physical_dir "$inbox") || die "--inbox is not an existing directory"
for dir in "$worktree_dir" "$inbox_dir"; do
  if inside_or_same "$(lowercase "$probe_path")" "$(lowercase "$dir")"; then
    die "--probe must be outside the worktree and the inbox"
  fi
done

command -v docker >/dev/null 2>&1 || die "docker is not on PATH"
docker image inspect "$image" >/dev/null 2>&1 ||
  die "image not found locally (build it first) or docker is not running"

launcher_args=(--worktree "$worktree_dir" --inbox "$inbox_dir" --name "isolation-check-$$" --image "$image")
if [ -n "$state_volume" ]; then
  launcher_args+=(--state-volume "$state_volume")
fi
printed=$("$BASH" "$LAUNCHER" "${launcher_args[@]}" --print-args -- sleep 1800) ||
  die "run-agent.sh refused these inputs"

docker_args=()
while IFS= read -r line; do
  docker_args+=("$line")
done <<EOF
$printed
EOF
if [ "${#docker_args[@]}" -lt 4 ] || [ "${docker_args[0]}" != run ]; then
  die "unexpected output from run-agent.sh --print-args"
fi
container=""
i=1
while [ "$i" -lt "$((${#docker_args[@]} - 1))" ]; do
  if [ "${docker_args[$i]}" = --name ]; then
    container=${docker_args[$((i + 1))]}
    break
  fi
  i=$((i + 1))
done
[ -n "$container" ] || die "run-agent.sh did not name the container"

extra=()
if [ "$expose" -eq 1 ]; then
  extra=(--mount "type=bind,source=$probe_dir,target=$probe_dir,readonly")
fi

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# -e NAME entries take their values from this script's environment, so the git
# identity that run-agent.sh exports for its own docker call is absent here.
if ! started=$(docker run --detach ${extra[@]+"${extra[@]}"} "${docker_args[@]:1}" 2>&1); then
  printf '%s\n' "$started" >&2
  die "could not start the check container"
fi
running=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  running=$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)
  if [ "$running" = true ]; then
    break
  fi
  sleep 1
done
[ "$running" = true ] || die "the check container is not running"

check_probe() {
  local result
  result=$(docker exec "$container" bash -c "$PROBE_SCRIPT" probe "$probe" "$probe_path" "$probe_name" 2>/dev/null || true)
  case "$result" in
    "absent 0") pass "a.  probe path absent; no file with its name anywhere in the container" ;;
    "absent "*) fail "a.  ${result#absent } file(s) with the probe's name found in the container" ;;
    "readable "*) fail "a.  probe readable, ${result#readable } bytes" ;;
    present) fail "a.  probe path exists in the container, though unreadable" ;;
    timeout) fail "a.  search for the probe's name timed out" ;;
    *) fail "a.  probe check did not run" ;;
  esac
}

check_mounts() {
  local raw type vname src dst rw binds=0 have_workspace=0 have_inbox=0 have_publication=0 have_requests=0 unexpected=0 note=""
  if ! raw=$(docker inspect --format "$MOUNTS_FORMAT" "$container" 2>/dev/null); then
    fail "b1. could not inspect the container's mounts"
    return
  fi
  while IFS=$SEP read -r type vname src dst rw; do
    [ -n "$type" ] || continue
    case "$type" in
      bind)
        binds=$((binds + 1))
        if [ "$dst" = /workspace ] && same_source "$src" "$worktree_dir" && [ "$rw" = true ]; then
          have_workspace=1
        elif [ "$dst" = /inbox ] && same_source "$src" "$inbox_dir" && [ "$rw" = true ]; then
          have_inbox=1
        elif [ "$dst" = /inbox/publication ] && same_source "$src" "$inbox_dir/publication" && [ "$rw" = false ]; then
          have_publication=1
        elif [ "$dst" = /inbox/publication/requests ] && same_source "$src" "$inbox_dir/publication/requests" && [ "$rw" = true ]; then
          have_requests=1
        else
          unexpected=$((unexpected + 1))
        fi
        ;;
      volume)
        if [ -n "$state_volume" ] && [ "$vname" = "$state_volume" ] && [ "$dst" = /home/node ] &&
          plain_volume "$vname"; then
          note=", plain state volume at /home/node"
        else
          unexpected=$((unexpected + 1))
        fi
        ;;
      *)
        unexpected=$((unexpected + 1))
        ;;
    esac
  done <<EOF
$raw
EOF
  if [ "$have_workspace" -eq 1 ] && [ "$have_inbox" -eq 1 ] && [ "$have_publication" -eq 1 ] && [ "$have_requests" -eq 1 ] &&
    [ "$binds" -eq 4 ] && [ "$unexpected" -eq 0 ]; then
    pass "b1. host mounts: worktree at /workspace and inbox at /inbox, read-write; inbox/publication read-only with its requests/ read-write$note; nothing else"
  else
    fail "b1. host mounts: $binds bind mount(s), $unexpected unexpected mount(s), worktree ok=$have_workspace, inbox ok=$have_inbox, publication ok=$have_publication, requests ok=$have_requests"
  fi
}

check_publication_area() {
  local out
  if ! out=$(docker exec "$container" bash -c "$PUBLICATION_SCRIPT" 2>/dev/null); then
    fail "h.  could not test the publication area"
    return
  fi
  if [ -z "$out" ]; then
    pass "h.  publication area: cannot be renamed or replaced, responses read-only, requests writable"
  else
    fail "h.  publication area: $(printf '%s' "$out" | tr '\n' ';' | sed 's/;$//')"
  fi
}

check_hardening() {
  local info privileged network ports devices capdrop secopt pidmode ipcmode uid problems=""
  if ! info=$(docker inspect --format "$HARDENING_FORMAT" "$container" 2>/dev/null); then
    fail "b2. could not inspect the container's security settings"
    return
  fi
  IFS='|' read -r privileged network ports devices capdrop secopt pidmode ipcmode <<EOF
$info
EOF
  uid=$(docker exec "$container" id -u 2>/dev/null || true)
  [ "$privileged" = false ] || problems="$problems privileged"
  [ "$network" != host ] || problems="$problems host-network"
  [ "$ports" = 0 ] || problems="$problems published-ports"
  [ "$devices" = 0 ] || problems="$problems devices"
  case "$capdrop" in
    *ALL* | *all*) ;;
    *) problems="$problems capabilities-kept" ;;
  esac
  case "$secopt" in
    *no-new-privileges*) ;;
    *) problems="$problems new-privileges-allowed" ;;
  esac
  [ "$pidmode" != host ] || problems="$problems host-pid"
  [ "$ipcmode" != host ] || problems="$problems host-ipc"
  case "$uid" in
    "" | 0) problems="$problems root-user" ;;
  esac
  if [ -z "$problems" ]; then
    pass "b2. hardening: unprivileged, all capabilities dropped, no-new-privileges, no host namespaces, ports or devices, uid $uid"
  else
    fail "b2. hardening problems:$problems"
  fi
}

# Positive control for c1-c4: a wrong name, a public repository, or one this
# machine cannot read would make the container's failures meaningless. Asks the
# GitHub CLI first, which also confirms the repository is private; otherwise runs
# git from / so that no repository's config applies. Prints nothing from either.
check_remote_control() {
  local private=""
  if command -v gh >/dev/null 2>&1; then
    private=$(gh api "repos/$remote" --jq .private </dev/null 2>/dev/null || true)
  fi
  case "$private" in
    true)
      pass "c0. control: the remote exists, is private, and this machine can read it"
      return
      ;;
    false)
      fail "c0. control: the remote is public, so it cannot show that credentials are missing"
      return
      ;;
  esac
  if GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=20" \
    git -C / ls-remote "git@github.com:$remote.git" >/dev/null 2>&1 ||
    GIT_TERMINAL_PROMPT=0 git -C / ls-remote "https://github.com/$remote.git" >/dev/null 2>&1; then
    pass "c0. control: this machine can read the private remote with its own credentials"
  else
    fail "c0. control: this machine cannot read the private remote with its own credentials, so c1-c4 prove nothing"
  fi
}

# Runs git in the container (from /workspace, so repository config applies).
run_git() {
  docker exec -e GIT_SSH_COMMAND="$SSH_TEST_COMMAND" "$container" timeout 90 git "$@" 2>&1
}

# $1 label, $2 ssh|https, $3 exit status, $4 combined output, $5 note on success.
# Returns 0 only when the attempt failed at authentication.
expect_auth_failure() {
  local line reason=""
  if [ "$3" -eq 0 ]; then
    fail "$1: succeeded, so credentials are usable or the repository is public$5"
    return 1
  fi
  while IFS= read -r line; do
    case "$2:$line" in
      ssh:*"Permission denied (publickey"* | \
        https:*"terminal prompts disabled"* | \
        https:*"could not read Username"* | \
        https:*"Authentication failed"*)
        reason=$line
        break
        ;;
    esac
  done <<EOF
$4
EOF
  if [ -n "$reason" ]; then
    pass "$1: rejected ($(clean "$reason"))"
    return 0
  fi
  reason=$(first_reason "$4")
  fail "$1: failed without an authentication error ($(clean "${reason:-no output, exit status $3}"))"
  return 1
}

check_git() {
  local ssh_url="git@github.com:$remote.git"
  local https_url="https://github.com/$remote.git"
  local branch="isolation-probe-$(date +%Y%m%d%H%M%S)-$$"
  local out status repo reads_rejected=1

  check_remote_control
  if out=$(run_git ls-remote "$ssh_url"); then status=0; else status=$?; fi
  expect_auth_failure "c1. git ls-remote over SSH" ssh "$status" "$out" "" || reads_rejected=0
  if out=$(run_git ls-remote "$https_url"); then status=0; else status=$?; fi
  expect_auth_failure "c2. git ls-remote over HTTPS" https "$status" "$out" "" || reads_rejected=0

  # An anonymous HTTPS read of a public repository succeeds, so c2 never passes
  # for one and no push is ever sent to it.
  if [ "$reads_rejected" -eq 0 ]; then
    fail "c3. git push over SSH: not attempted, because c1 or c2 was not rejected at authentication"
    fail "c4. git push over HTTPS: not attempted, for the same reason"
    return
  fi
  if ! repo=$(docker exec "$container" bash -c "$PUSH_REPO_SCRIPT" 2>/dev/null) || [ -z "$repo" ]; then
    fail "c3. git push over SSH: could not create the throwaway repository"
    fail "c4. git push over HTTPS: could not create the throwaway repository"
    return
  fi
  if out=$(run_git -C "$repo" push "$ssh_url" "HEAD:refs/heads/$branch"); then status=0; else status=$?; fi
  expect_auth_failure "c3. git push over SSH" ssh "$status" "$out" "; delete branch $branch" || true
  if out=$(run_git -C "$repo" push "$https_url" "HEAD:refs/heads/$branch"); then status=0; else status=$?; fi
  expect_auth_failure "c4. git push over HTTPS" https "$status" "$out" "; delete branch $branch" || true
}

check_env() {
  local names name flagged="" allowed=""
  if ! names=$(docker exec "$container" bash -c "$ENV_SCRIPT" 2>/dev/null); then
    fail "d.  could not list environment variable names"
    return
  fi
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    case "$ALLOWED_ENV" in
      *" $name "*) allowed="$allowed $name" ;;
      *) flagged="$flagged $name" ;;
    esac
  done <<EOF
$names
EOF
  if [ -n "$flagged" ]; then
    fail "d.  credential-like variables outside the allowlist:$flagged"
  else
    pass "d.  no credential-like variables outside the allowlist (allowlisted present:${allowed:- none})"
  fi
}

check_files() {
  local found
  if ! found=$(docker exec "$container" bash -c "$FILES_SCRIPT" 2>/dev/null); then
    fail "e.  could not check for credential files"
    return
  fi
  if [ -z "$found" ]; then
    pass "e.  no ~/.ssh, gh, git-credentials, netrc, vercel or docker config, agent or docker socket, git credential setting, ssh command or URL with credentials"
  else
    fail "e.  found: $(printf '%s' "$found" | tr '\n' ' ')"
  fi
}

check_versions() {
  local out
  out=$(docker exec "$container" bash -c "$VERSIONS_SCRIPT" 2>/dev/null || true)
  out=$(printf '%s' "$out" | tr '\n' ';' | sed -e 's/;$//' -e 's/;/, /g')
  case "$out" in
    "" | *=missing*) fail "f.  tool versions: ${out:-none}" ;;
    *) pass "f.  tool versions: $out" ;;
  esac
}

# Docker Desktop relays host.docker.internal to this machine, including services
# that listen only on its loopback interface.
check_host_services() {
  local open ports
  if ! open=$(docker exec "$container" bash -c "$HOST_PORTS_SCRIPT" ports "$DB_PORTS" 2>/dev/null); then
    fail "g.  could not test connections to this machine"
    return
  fi
  if [ -z "$open" ]; then
    note "g.  no database port on this machine answers through host.docker.internal ($DB_PORTS)"
  else
    ports=$(printf '%s\n' "$open" | tr '\n' ' ')
    note "g.  database port(s) on this machine reachable through host.docker.internal: ${ports% }; stop those services or require passwords while agents run"
  fi
}

if [ "$expose" -eq 1 ]; then
  echo "Isolation check, --expose control: one extra read-only mount of the probe's directory, so checks a and b1 must fail"
  check_probe
  probe_verdict="$last:$last_text"
  check_mounts
  mounts_verdict="$last:$last_text"
  case "$probe_verdict" in
    "fail:"*"probe readable, "*)
      case "$mounts_verdict" in
        "fail:"*"5 bind mount(s), 1 unexpected"*)
          echo "Summary: control behaved as expected; checks a and b1 failed on the exposed path"
          exit 0
          ;;
      esac
      ;;
  esac
  echo "Summary: control did not behave as expected; checks a and b1 must both fail on the exposed path"
  exit 1
fi

echo "Isolation check, normal run"
check_probe
check_mounts
check_publication_area
check_hardening
check_git
check_env
check_files
check_versions
check_host_services
printf 'Summary: %d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ] || exit 1
