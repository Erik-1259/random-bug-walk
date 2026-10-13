// The tool interface the solver agent loop (packages/solver) calls. A session implements it over
// one kit container. Every method returns plain JSON-safe data; text is UTF-8 (invalid bytes are
// replaced). A call the session refuses resolves with `ok: false` and a reason; it never throws
// for something the agent did, only for an infrastructure failure (SessionError).
//
// Calls are serialized: a session runs one call at a time, in the order they were made, so a
// loop may issue a model's parallel tool calls at once and each still sees the previous one's
// effects.

export interface RunResult {
  /** The command's exit status; 124 when it timed out; null when it could not run. */
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

export type ReadResult = { ok: true; content: string; truncated: boolean } | { ok: false; reason: string };

export type WriteResult = { ok: true; sha256: string; bytes: number } | { ok: false; reason: string };

export interface RebuildResult {
  /** True when the build exited 0 and the app answered its heartbeat. */
  ok: boolean;
  /**
   * Refused before the build ran: "rebuild_cap" (the other fields are empty) or "not_cold" (the
   * tree was still warm after the reset, from something the agent left; build.output says what).
   */
  refused: string | null;
  build: { exit_code: number | null; output: string };
  /** rbw-start's own lines only: the runtime output is scrubbed in both arms (see scrub.ts). */
  start: { exit_code: number | null; output: string; withheld_lines: number } | null;
}

/** Byte offsets into each log, as the last server_logs call left them. */
export interface LogCursor {
  /** The app start the offsets belong to; each start truncates the logs. */
  generation: number;
  umami: number;
  postgres: number;
}

export interface LogSlice {
  text: string;
  /** The log's size when it was read. */
  size: number;
  /** More bytes follow this slice. */
  more: boolean;
  /**
   * The app was started again since the cursor (the slice then reads the new log from its
   * start), or the log is shorter than the cursor (the slice is then its tail).
   */
  restarted: boolean;
}

export type ServerLogsResult = { ok: true; umami: LogSlice; postgres: LogSlice; cursor: LogCursor } | { ok: false; reason: string };

export interface SubmitResult {
  /** in_scope: only the target file changed (or nothing did); out_of_scope: any other tracked file changed. */
  scope: "in_scope" | "out_of_scope";
  /** Tracked paths that differ from the neutral commit, sorted, with how. */
  changed: { path: string; change: "modified" | "deleted" | "mode" | "type" }[];
  /** The target file's SHA-256 as submitted; null when it is missing. */
  target_sha256: string | null;
  /** A git-style diff of the target file against the neutral commit; empty when unchanged. */
  target_patch: string;
}

export interface SolverTools {
  /** `sh -c <cmd>` as the unprivileged app user (rbw-app) in /workspace/app, with a timeout. */
  run(cmd: string): Promise<RunResult>;
  /** A file as the app user can read it; a relative path is under /workspace/app. */
  readFile(path: string): Promise<ReadResult>;
  /** Writes a tracked file under the app tree, as root, keeping the file's owner and mode; not one the build regenerates. */
  writeFile(path: string, content: string): Promise<WriteResult>;
  /** rbw-stop, ending every rbw-app process, the cold-build reset, rbw-build-app, then rbw-start. */
  rebuildRestart(): Promise<RebuildResult>;
  /** A byte-capped slice of umami.stderr.log and postgres.stderr.log; refused in the off arm. */
  serverLogs(cursor?: LogCursor | null): Promise<ServerLogsResult>;
  /** Ends the attempt: extracts the diff against the neutral commit over tracked files. */
  submit(): Promise<SubmitResult>;
}
