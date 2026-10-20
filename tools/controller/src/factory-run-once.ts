// The run-once guard for a command started in a sandbox. The Sandbox SDK retries a request after a
// network or 5xx error, so a command whose start succeeded but whose response was lost can start a
// second time (tools/local-runner/README.md, "Once per sandbox"). Under this guard only the first
// start runs the command: `mkdir` of the lock lets one instance win, which records the command's exit
// status; any later start waits for that marker and exits with the same status. 90 means the guard
// itself could not run. The copy runner guards each copy's command with it and the launch guards the
// worker command. Web-safe: no imports.

export const RUN_ONCE_SCRIPT = [
  "set -u",
  'dir="$1"',
  "shift",
  'lock="$dir/lock"',
  'marker="$dir/status"',
  'mkdir -p "$dir" || exit 90',
  'if ! mkdir "$lock" 2> /dev/null; then',
  '  [ -d "$lock" ] || exit 90',
  '  while [ ! -s "$marker" ]; do sleep 1; done',
  '  read -r status < "$marker"',
  '  exit "$status"',
  "fi",
  '"$@"',
  "status=$?",
  'echo "$status" > "$marker.tmp" && mv "$marker.tmp" "$marker"',
  'exit "$status"',
].join("\n");

/** `sh -c RUN_ONCE_SCRIPT <name> <dir> <command...>`: the command, run at most once for the lock directory `dir`. */
export function runOnceCommand(name: string, dir: string, command: readonly string[]): { cmd: "sh"; args: string[] } {
  return { cmd: "sh", args: ["-c", RUN_ONCE_SCRIPT, name, dir, ...command] };
}
