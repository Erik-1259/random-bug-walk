// The session as packages/solver's SolverSession, so a Session can be handed to runAttempt. The
// solver keeps its own tool layer (input checks, byte caps, the rebuild cap, its runtime-log
// scrub); this adapter only maps the calls and results. Open the session with `serverLogs` equal
// to the solver arm's ("on": true). The attempt's diff is taken after runAttempt returns, with
// session.submit() or session.end("cap"), and close() still belongs to the caller.
import type { CommandResult, FileResult, ServerLogsPage, SolverSession, RebuildResult as SolverRebuildResult, WriteResult as SolverWriteResult } from "@rbw/solver";
import { SessionError } from "./session.ts";
import type { Session } from "./session.ts";
import type { LogCursor, LogSlice } from "./tools.ts";

/** Bytes kept for the two log headers out of the solver's page cap; the rest is split between the logs. */
const HEADER_BYTES = 256;
const CURSOR = /^(\d{1,9})\.(\d{1,15})\.(\d{1,15})$/;

/** The opaque next_cursor the model sees: `<generation>.<umami offset>.<postgres offset>`. */
export function encodeCursor(cursor: LogCursor): string {
  return `${String(cursor.generation)}.${String(cursor.umami)}.${String(cursor.postgres)}`;
}

/** The cursor a model passed back; anything else reads the tail, as no cursor does. */
export function decodeCursor(text: string | null): LogCursor | null {
  const match = text === null ? null : CURSOR.exec(text);
  if (match === null) return null;
  return { generation: Number(match[1]), umami: Number(match[2]), postgres: Number(match[3]) };
}

function section(name: string, slice: LogSlice): string {
  return `--- ${name}\n${slice.text}${slice.text === "" || slice.text.endsWith("\n") ? "" : "\n"}`;
}

/** A killed build or start (docker's own timeout) has no exit status; the solver's result needs one. */
function exitCode(code: number | null): number {
  return code ?? -1;
}

class SessionAsSolverSession implements SolverSession {
  private readonly session: Session;

  constructor(session: Session) {
    this.session = session;
  }

  async bash(command: string, options: { timeoutMs: number }): Promise<CommandResult> {
    const result = await this.session.run(command, options.timeoutMs);
    return { exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, timed_out: result.timed_out };
  }

  async readFile(path: string): Promise<FileResult> {
    const result = await this.session.readFile(path);
    return result.ok ? { ok: true, content: result.content } : { ok: false, error: result.reason };
  }

  async writeFile(path: string, content: string): Promise<SolverWriteResult> {
    const result = await this.session.writeFile(path, content);
    return result.ok ? { ok: true } : { ok: false, error: result.reason };
  }

  async rebuildRestart(): Promise<SolverRebuildResult> {
    const { result, build } = await this.session.rebuildRestartWithBuild();
    if (build === null) {
      // Nothing was built: the session's cap, or a tree still warm after the reset (build.output says what).
      const message = result.refused === "rebuild_cap" ? "the session's rebuild cap is reached; nothing was rebuilt\n" : result.build.output;
      return { build: { exit_code: 1, stdout: "", stderr: message }, start: null };
    }
    return {
      build: { exit_code: exitCode(build.exit_code), stdout: build.stdout, stderr: build.stderr },
      // The session's scrubbed start output: rbw-start's own lines only, so no runtime log line is passed on.
      start: result.start === null ? null : { exit_code: exitCode(result.start.exit_code), stdout: result.start.output, stderr: "" },
    };
  }

  async serverLogs(request: { cursor: string | null; maxBytes: number }): Promise<ServerLogsPage> {
    const perLog = Math.max(0, Math.floor((request.maxBytes - HEADER_BYTES) / 2));
    const result = await this.session.serverLogs(decodeCursor(request.cursor), perLog);
    if (!result.ok) throw new SessionError(result.reason, "the session was opened for the off arm; open it with serverLogs: true for the on arm");
    return {
      text: `${section("umami.stderr.log", result.umami)}${section("postgres.stderr.log", result.postgres)}`,
      next_cursor: encodeCursor(result.cursor),
      truncated: result.umami.restarted || result.postgres.restarted,
    };
  }
}

/** The session as packages/solver's SolverSession, for runAttempt. */
export function solverSession(session: Session): SolverSession {
  return new SessionAsSolverSession(session);
}
