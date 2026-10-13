// The pre-registered contamination check: an attempt, in either arm, that starts its own server
// process or reads Umami's or Postgres's process output outside server_logs. It is detected from
// the attempt's bash commands by pattern, so it is a heuristic: it is counted and reported per
// arm, and never used to exclude an attempt.

export type ContaminationKind = "starts_server" | "reads_process_output";

export interface ContaminationHit {
  kind: ContaminationKind;
  /** The index of the bash command in the attempt's order. */
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

/** Every pattern hit in the attempt's bash commands, in command order. */
export function contaminationHits(commands: readonly string[]): ContaminationHit[] {
  const hits: ContaminationHit[] = [];
  commands.forEach((command, index) => {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(command)) {
        hits.push({ kind: pattern.kind, command_index: index, pattern: pattern.name });
      }
    }
  });
  return hits;
}

/** Whether the attempt is flagged as contaminated. */
export function isContaminated(commands: readonly string[]): boolean {
  return contaminationHits(commands).length > 0;
}
