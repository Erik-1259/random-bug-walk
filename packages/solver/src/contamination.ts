// The pre-registered contamination check: an attempt, in either arm, that starts its own server
// process or reads Umami's or Postgres's process output outside server_logs. It is detected from
// the attempt's bash commands by pattern, and from any read_file or write_file path into the rbw
// log directory (whether or not the session refused it), so it is a heuristic: it is counted and
// reported per arm, and never used to exclude an attempt.

import { posix } from "node:path";

export type ContaminationKind = "starts_server" | "reads_process_output";

export interface ContaminationHit {
  kind: ContaminationKind;
  /** Where it was seen: a bash command, or a read_file or write_file path. */
  tool: "bash" | "file";
  /** The index of the bash command, or of the file-tool path, in the attempt's order. */
  command_index: number;
  pattern: string;
}

const PATTERNS: readonly { kind: ContaminationKind; name: string; regex: RegExp }[] = [
  { kind: "starts_server", name: "node server.js", regex: /\bnode\s+(?:\S*\/)?server\.js\b/ },
  { kind: "starts_server", name: "next start or dev", regex: /\bnext\s+(?:start|dev)\b/ },
  { kind: "starts_server", name: "package start or dev script", regex: /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?(?:start|dev)\b/ },
  { kind: "starts_server", name: "rbw-start", regex: /\brbw-start\b/ },
  { kind: "starts_server", name: "postgres or pg_ctl", regex: /\b(?:pg_ctl|postgres)\s+-D\b|\bpg_ctl\s+start\b/ },
  { kind: "reads_process_output", name: "rbw log directory", regex: /\/var\/lib\/rbw\/logs\b/ },
  { kind: "reads_process_output", name: "process file descriptors", regex: /\/proc\/(?:\d+|self|\*)\/fd\b/ },
  { kind: "reads_process_output", name: "strace or ltrace", regex: /\b(?:strace|ltrace)\b/ },
  { kind: "reads_process_output", name: "journalctl", regex: /\bjournalctl\b/ },
];

/** The app's root directory in the container, from which the session resolves relative file-tool paths. */
const APP_ROOT = "/workspace/app";
const LOG_DIRECTORY = "/var/lib/rbw/logs";

/**
 * Whether a file-tool path, resolved as the session would from the app's root directory, lands in
 * the rbw log directory: an absolute path into it, or a ../ traversal that reaches it. A relative
 * path such as var/lib/rbw/logs/x names a file in the app tree and does not count.
 */
function isLogDirectoryPath(path: string): boolean {
  const resolved = posix.resolve(APP_ROOT, path);
  return resolved === LOG_DIRECTORY || resolved.startsWith(`${LOG_DIRECTORY}/`);
}

/** Every pattern hit in the attempt's bash commands, in command order, then its file-tool paths into the log directory. */
export function contaminationHits(commands: readonly string[], filePaths: readonly string[] = []): ContaminationHit[] {
  const hits: ContaminationHit[] = [];
  commands.forEach((command, index) => {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(command)) {
        hits.push({ kind: pattern.kind, tool: "bash", command_index: index, pattern: pattern.name });
      }
    }
  });
  filePaths.forEach((path, index) => {
    if (isLogDirectoryPath(path)) {
      hits.push({ kind: "reads_process_output", tool: "file", command_index: index, pattern: "rbw log directory" });
    }
  });
  return hits;
}

/** Whether the attempt is flagged as contaminated. */
export function isContaminated(commands: readonly string[], filePaths: readonly string[] = []): boolean {
  return contaminationHits(commands, filePaths).length > 0;
}
