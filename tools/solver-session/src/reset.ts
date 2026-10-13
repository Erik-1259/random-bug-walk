// The cold-build reset between two builds of one solver session. The kit's rbw-build-app refuses
// a warm build (rbw-check-cold), so before each rebuild every path in kit/umami/build-outputs.txt
// goes back to the image's ownership, modes and contents, and the users' temp directories and the
// caches that check names are emptied.
//
// The image's state of those paths is measured once, in the fresh container before its first
// build (the snapshot script), and the reset script restores exactly that. Both run as root in the
// container. Their first argument is a root prefix: empty in a container, a temporary directory in
// the tests, which run the real scripts and the kit's own rbw-check-cold against a directory tree.
import { readFileSync } from "node:fs";
import { KIT_BUILD_OUTPUTS } from "@rbw/local-runner";

export type BuildOutputKind = "dir" | "file" | "sticky" | "tracked";

export interface BuildOutput {
  kind: BuildOutputKind;
  path: string;
}

export class BuildOutputsError extends Error {
  override name = "BuildOutputsError";
}

const KINDS: readonly string[] = ["dir", "file", "sticky", "tracked"];
const SAFE_PATH = /^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/;

/**
 * The entries of a build-outputs list (kit/umami/build-outputs.txt's format: `<kind> <path>` per
 * line, `#` comments). An unknown kind or an unsafe path refuses the list, as the Dockerfile does.
 */
export function parseBuildOutputs(text: string): BuildOutput[] {
  const entries: BuildOutput[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const [kind, path] = parts;
    if (parts.length !== 2 || kind === undefined || path === undefined) throw new BuildOutputsError(`malformed build output line: ${line}`);
    if (!KINDS.includes(kind)) throw new BuildOutputsError(`unknown build output kind: ${kind}`);
    if (!SAFE_PATH.test(path) || path.split("/").some((segment) => segment === "." || segment === "..")) throw new BuildOutputsError(`unsafe build output path: ${path}`);
    entries.push({ kind: kind as BuildOutputKind, path });
  }
  if (entries.length === 0) throw new BuildOutputsError("the build-outputs list is empty");
  return entries;
}

/** The repository's kit/umami/build-outputs.txt, which the image copies to /opt/rbw/etc/build-outputs.txt. */
export function kitBuildOutputs(): { text: string; entries: BuildOutput[] } {
  const text = readFileSync(KIT_BUILD_OUTPUTS, "utf8");
  return { text, entries: parseBuildOutputs(text) };
}

/** Where the session keeps the snapshot, root-only, beside the kit's own /var/lib/rbw state. */
export const SESSION_STATE_DIR = "/var/lib/rbw/session";

/**
 * Records, for each build output, its owner, group and mode; a copy of each tracked one; and the
 * entries of each sticky directory. Refuses a missing output or one that is a symlink. Runs once.
 */
export const SNAPSHOT_SCRIPT = `set -eu
root=$1
app="$root/workspace/app"
state="$root${SESSION_STATE_DIR}"
fail() { echo "rbw-snapshot: $1" >&2; exit 2; }
[ ! -e "$state/owners" ] || fail "a snapshot already exists"
mkdir -p "$state/pristine" "$state/sticky"
chmod 0700 "$state"
: > "$state/owners.part"
while read -r kind path rest; do
  case $kind in
    '' | '#'*) continue ;;
    dir | file | sticky | tracked) ;;
    *) fail "unknown build output kind: $kind" ;;
  esac
  target="$app/$path"
  if [ -L "$target" ] || [ ! -e "$target" ]; then fail "missing build output: $path"; fi
  printf '%s %s %s\\n' "$kind" "$(stat -c '%u:%g:%a' "$target")" "$path" >> "$state/owners.part"
  case $kind in
    tracked)
      mkdir -p "$(dirname "$state/pristine/$path")"
      cp -p "$target" "$state/pristine/$path"
      ;;
    sticky)
      mkdir -p "$(dirname "$state/sticky/$path")"
      ls -A "$target" > "$state/sticky/$path.list"
      ;;
  esac
done < "$root/opt/rbw/etc/build-outputs.txt"
mv "$state/owners.part" "$state/owners"
echo "snapshot_entries=$(wc -l < "$state/owners" | tr -d ' ')"
`;

/**
 * Puts every build output back as the snapshot found it: dir and file outputs recreated empty,
 * tracked ones copied back, entries a build added to a sticky directory removed; each with its
 * recorded owner, group and mode. Then empties the users' temp directories and removes the caches
 * rbw-check-cold names. Run after rbw-stop, so no app or database process is writing.
 */
export const RESET_SCRIPT = `set -eu
root=$1
app="$root/workspace/app"
state="$root${SESSION_STATE_DIR}"
fail() { echo "rbw-reset: $1" >&2; exit 2; }
[ -f "$state/owners" ] || fail "no snapshot"
restore() {
  chown "\${2%:*}" "$1"
  chmod "\${2##*:}" "$1"
}
while read -r kind owner path; do
  target="$app/$path"
  case $kind in
    dir)
      rm -rf "$target"
      mkdir "$target"
      restore "$target" "$owner"
      ;;
    file)
      rm -rf "$target"
      : > "$target"
      restore "$target" "$owner"
      ;;
    tracked)
      rm -rf "$target"
      cp -p "$state/pristine/$path" "$target"
      restore "$target" "$owner"
      ;;
    sticky)
      if [ -L "$target" ] || [ ! -d "$target" ]; then fail "sticky output is not a directory: $path"; fi
      ls -A "$target" | while IFS= read -r name; do
        grep -qxF -e "$name" "$state/sticky/$path.list" || rm -rf "$target/$name"
      done
      restore "$target" "$owner"
      ;;
    *) fail "unknown snapshot kind: $kind" ;;
  esac
done < "$state/owners"
for dir in "$root/var/tmp/rbw-app" "$root/var/tmp/rbw-db"; do
  [ -d "$dir" ] || continue
  find "$dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} \\;
done
rm -rf "$app/.turbo" "$app/node_modules/.cache"
echo "reset_entries=$(wc -l < "$state/owners" | tr -d ' ')"
`;

/** The docker exec argument list (after the container name) that runs one of the scripts as root. */
export function scriptArgs(script: string, name: string, root = ""): string[] {
  return ["/bin/sh", "-c", script, name, root];
}
