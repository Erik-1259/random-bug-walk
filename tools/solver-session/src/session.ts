// One solver attempt's session on local Docker. Opening it derives and audits the planted
// projection with tools/local-runner's own export, code states and audit; starts a fresh
// container of the pinned kit image (no network, spec §9.4's 4 vCPU and 8 GB); places the planted
// file; checks that the container's tracked files are exactly the audited projection; snapshots
// the build outputs; and builds and starts the app the same way in both arms. The session then
// serves the solver's tools (tools.ts) until submit, and close() keeps the logs and removes the
// container.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { APP_DIR, COPY_RESOURCES, CodeStateRefusal, ExportError, InputsError, PlanError, auditCopy, deriveCodeStates, exportImage, inspectImage, loadCopyInputs } from "@rbw/local-runner";
import type { AuditResult, Clock, CommandResult, CopyInputOptions, Docker } from "@rbw/local-runner";
import { sha256Hex } from "@rbw/schema";
import { KILL_APP_SCRIPT, RESET_SCRIPT, SESSION_STATE_DIR, SNAPSHOT_SCRIPT, kitBuildOutputs, scriptArgs } from "./reset.ts";
import { scrubStartOutput, tailText } from "./scrub.ts";
import { compareTracked, readContainerTracked, submission } from "./tracked.ts";
import type { LogCursor, LogSlice, ReadResult, RebuildResult, RunResult, ServerLogsResult, SolverTools, SubmitResult, WriteResult } from "./tools.ts";

export interface SessionLimits {
  /** run(): the command's own timeout. */
  commandTimeoutMs: number;
  /** run(): bytes kept per stream. */
  outputBytes: number;
  /** readFile(): bytes returned. */
  readBytes: number;
  /** writeFile(): largest file accepted. */
  writeBytes: number;
  /** serverLogs(): bytes per log per call, at most. */
  logBytes: number;
  /** rebuildRestart(): calls per attempt (the pre-registered cap is 8). */
  maxRebuilds: number;
  /** rebuildRestart(): build output returned, from its end. */
  buildOutputBytes: number;
}

export const DEFAULT_LIMITS: SessionLimits = {
  commandTimeoutMs: 120_000,
  outputBytes: 65_536,
  readBytes: 262_144,
  writeBytes: 1_048_576,
  logBytes: 16_384,
  maxRebuilds: 8,
  buildOutputBytes: 65_536,
};

export interface SessionOptions extends CopyInputOptions {
  /** The attempt's ID: lower-case letters, digits and dashes; the container is rbw-solver-<id>. */
  id: string;
  /** The kit image (tag or digest); every container runs by its content digest. */
  image: string;
  /**
   * The content digest the image must resolve to (sha256:...), or null to accept whatever it
   * resolves to. A counted attempt passes the digest its case admits; null is for a smoke run.
   */
  expectedDigest: string | null;
  /** Must be absent or empty. */
  work: string;
  /** The on arm: server_logs is served. The off arm refuses it. */
  serverLogs: boolean;
  limits?: Partial<SessionLimits>;
}

export interface SessionDeps {
  docker: Docker;
  clock: Clock;
}

/** Refused before the container exists (inputs, image, export, code states or audit). */
export class SessionRefusal extends Error {
  override name = "SessionRefusal";
  readonly reason: string;

  constructor(reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
  }
}

/** An infrastructure failure after the container exists; the attempt is an infrastructure error. */
export class SessionError extends Error {
  override name = "SessionError";
  readonly reason: string;

  constructor(reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
  }
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const STOP_TIMEOUT_MS = 150_000;
const SCRIPT_TIMEOUT_MS = 300_000;
/** rbw-build-app's own launcher limit (1 800 s) plus a margin. */
const BUILD_TIMEOUT_MS = 1_900_000;
const START_TIMEOUT_MS = 400_000;
const DOCKER_MARGIN_MS = 60_000;
/** Staging files for write_file, one per placement: <INCOMING>-<n>. */
const INCOMING = `${SESSION_STATE_DIR}/incoming`;
const LOGS_DIR = "/var/lib/rbw/logs";
const LOG_FILES = { umami: `${LOGS_DIR}/umami.stderr.log`, postgres: `${LOGS_DIR}/postgres.stderr.log` } as const;

/**
 * Writes the staging file $3 over the tracked file $2 under the app directory $1 in place, so the
 * file keeps its owner and mode, and removes the staging file. Exit 3: not a regular file.
 */
export const PLACE_SCRIPT = `set -eu
target="$1/$2"
if [ -L "$target" ] || [ ! -f "$target" ]; then rm -f "$3"; echo "not a regular file" >&2; exit 3; fi
cat "$3" > "$target"
rm -f "$3"
sha256sum "$target"
`;

/** Prints "<size> <start>" and then the log's bytes from <start>, at most <max>. A negative offset asks for the tail. */
export const LOG_SLICE_SCRIPT = `set -eu
f=$1; off=$2; max=$3
if [ -f "$f" ]; then size=$(stat -c %s "$f"); else size=0; fi
if [ "$off" -lt 0 ] || [ "$off" -gt "$size" ]; then
  if [ "$size" -gt "$max" ]; then start=$((size - max)); else start=0; fi
else
  start=$off
fi
printf '%s %s\\n' "$size" "$start"
if [ "$size" -gt 0 ]; then tail -c +$((start + 1)) "$f" | head -c "$max"; fi
`;

function text(buffer: Buffer): string {
  return buffer.toString("utf8");
}

export interface OpenedSession {
  digest: string;
  audit: AuditResult;
  planted_sha256: string;
  initial: RebuildResult;
}

export class Session implements SolverTools {
  readonly container: string;
  readonly work: string;
  readonly limits: SessionLimits;
  private readonly options: SessionOptions;
  private readonly deps: SessionDeps;
  private projection = "";
  private target = "";
  private tracked: string[] = [];
  private writable = new Set<string>();
  /** Tracked paths the agent may write and the submission is scoped over: the build's outputs are left out. */
  private scoped: string[] = [];
  private digest = "";
  private rebuilds = 0;
  /** Bumped on every rbw-start, which truncates both logs; a log cursor names the generation it read. */
  private logGeneration = 0;
  private staged = 0;
  /** Tool calls, end() and close() run one at a time, in call order. */
  private queue: Promise<unknown> = Promise.resolve();
  private started = false;
  private submitted: SubmitResult | null = null;
  private closed = false;
  /** Set once the container is gone (or never started); close() then does nothing. */
  private removed = false;
  private logCopies = 0;

  private constructor(options: SessionOptions, deps: SessionDeps) {
    this.options = options;
    this.deps = deps;
    this.container = `rbw-solver-${options.id}`;
    this.work = options.work;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  /** Opens a session: refuses (SessionRefusal) before any container on a bad input or audit. */
  static async open(options: SessionOptions, deps: SessionDeps): Promise<{ session: Session; opened: OpenedSession }> {
    if (!ID.test(options.id)) throw new SessionRefusal("bad_id", "the attempt ID must be lower-case letters, digits and dashes");
    if (existsSync(options.work) && readdirSync(options.work).length > 0) throw new SessionRefusal("work_not_empty", "the work directory must be absent or empty");
    mkdirSync(options.work, { recursive: true });
    const session = new Session(options, deps);
    const prepared = await session.prepare();
    try {
      const initial = await session.startContainer(prepared.digest, prepared.planted);
      return { session, opened: { digest: prepared.digest, audit: prepared.audit, planted_sha256: sha256Hex(prepared.planted), initial } };
    } catch (error) {
      try {
        await session.close();
      } catch {
        // The original failure is the one to report; close() records its own in events.jsonl.
      }
      throw error;
    }
  }

  /** Runs one call after every call made before it has settled. */
  private serial<T>(call: () => Promise<T>): Promise<T> {
    const next = this.queue.then(call, call);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private event(op: string, detail: Record<string, unknown> = {}): void {
    appendFileSync(join(this.work, "events.jsonl"), `${JSON.stringify({ at: new Date(this.deps.clock.now()).toISOString(), op, ...detail })}\n`);
  }

  private async prepare(): Promise<{ digest: string; audit: AuditResult; planted: Buffer }> {
    try {
      const inputs = loadCopyInputs(this.options);
      const digest = await inspectImage(this.deps.docker, this.options.image);
      if (this.options.expectedDigest !== null && digest !== this.options.expectedDigest) {
        throw new SessionRefusal("image_mismatch", `${this.options.image} is ${digest}, not the expected ${this.options.expectedDigest}`);
      }
      this.digest = digest;
      const exported = await exportImage(this.deps.docker, { image: digest, container: `${this.container}-export`, dest: join(this.work, "source") });
      this.target = inputs.probes.data.target_path;
      const states = deriveCodeStates(readFileSync(join(exported.source_dir, this.target)), inputs.probes, inputs.alternative);
      const planted = states.get("planted");
      if (planted === undefined) throw new SessionRefusal("no_planted_state", "the probes give no planted file");
      const audit = auditCopy({
        sourceDir: exported.source_dir,
        workDir: join(this.work, "audit"),
        state: planted,
        manifestPath: inputs.manifestPath,
        termsPath: inputs.termsPath,
        policyPath: inputs.policyPath,
      });
      this.event("prepared", { digest, audit, planted_sha256: planted.sha256 });
      if (audit.verdict !== "pass") throw new SessionRefusal("audit_not_passed", `the planted projection's audit is ${audit.verdict} (${audit.reason ?? "no reason"})`);
      this.projection = join(this.work, "audit", "projection");
      this.tracked = inputs.manifest.files.map((file) => file.path);
      // The build rewrites its tracked outputs (kit/umami/build-outputs.txt) from other sources,
      // and the reset puts them back before every build, so they are neither the agent's to write
      // nor part of its diff. The overlay check still covers them, before any build.
      const outputs = new Set(kitBuildOutputs().entries.map((entry) => entry.path));
      this.scoped = this.tracked.filter((path) => path === this.target || !outputs.has(path));
      this.writable = new Set(this.scoped);
      return { digest, audit, planted: planted.bytes };
    } catch (error) {
      if (error instanceof PlanError || error instanceof ExportError || error instanceof CodeStateRefusal || error instanceof InputsError) {
        throw new SessionRefusal("cannot_prepare", error.message);
      }
      throw error;
    }
  }

  private exec(args: readonly string[], timeoutMs: number): Promise<CommandResult> {
    return this.deps.docker.run(["exec", "--user", "0:0", this.container, ...args], { timeoutMs: timeoutMs + DOCKER_MARGIN_MS });
  }

  private async execOk(what: string, args: readonly string[], timeoutMs: number): Promise<CommandResult> {
    const result = await this.exec(args, timeoutMs);
    if (result.code !== 0) throw new SessionError(`${what}_failed`, `exit ${String(result.code)}: ${text(result.stdout)}${result.stderr}`.trim());
    return result;
  }

  private async startContainer(digest: string, planted: Buffer): Promise<RebuildResult> {
    const created = await this.deps.docker.run(["run", "--detach", "--name", this.container, ...COPY_RESOURCES, digest, "tail", "-f", "/dev/null"], { timeoutMs: SCRIPT_TIMEOUT_MS });
    if (created.code !== 0) throw new SessionError("container_start_failed", created.stderr.trim());
    this.started = true;
    this.event("container_started", { container: this.container, digest });
    const outputs = await this.execOk("build_outputs_read", ["cat", "/opt/rbw/etc/build-outputs.txt"], SCRIPT_TIMEOUT_MS);
    if (text(outputs.stdout) !== kitBuildOutputs().text) throw new SessionError("build_outputs_mismatch", "the image's build-outputs.txt is not kit/umami/build-outputs.txt");
    await this.execOk("state_dir", ["install", "-d", "-o", "0", "-g", "0", "-m", "0700", SESSION_STATE_DIR], SCRIPT_TIMEOUT_MS);
    const placed = await this.place(this.target, planted);
    if (!placed.ok) throw new SessionError("overlay_failed", placed.reason);
    const current = await readContainerTracked(this.deps.docker, this.container, this.tracked);
    const { changed } = compareTracked(this.projection, this.tracked, current, this.target);
    if (changed.length > 0) throw new SessionError("overlay_mismatch", `the container's tracked files differ from the audited projection: ${changed.map((item) => item.path).join(", ")}`);
    await this.execOk("snapshot", scriptArgs(SNAPSHOT_SCRIPT, "rbw-snapshot"), SCRIPT_TIMEOUT_MS);
    this.event("overlaid", { target: this.target, planted_sha256: sha256Hex(planted), tracked: this.tracked.length });
    const initial = await this.buildAndStart("initial", false);
    if (!initial.ok) throw new SessionError("initial_start_failed", initial.start?.output ?? initial.build.output);
    return initial;
  }

  /** Places bytes over a tracked file through a staging file, as root, keeping its owner and mode. */
  private async place(path: string, bytes: Buffer): Promise<WriteResult> {
    const incoming = join(this.work, "incoming");
    mkdirSync(incoming, { recursive: true });
    this.staged += 1;
    const host = join(incoming, `${String(this.staged).padStart(4, "0")}-${sha256Hex(bytes).slice(0, 16)}`);
    const staging = `${INCOMING}-${String(this.staged)}`;
    writeFileSync(host, bytes, { mode: 0o644 });
    const copied = await this.deps.docker.run(["cp", host, `${this.container}:${staging}`], { timeoutMs: SCRIPT_TIMEOUT_MS });
    if (copied.code !== 0) throw new SessionError("copy_in_failed", copied.stderr.trim());
    const result = await this.exec(["/bin/sh", "-c", PLACE_SCRIPT, "rbw-place", APP_DIR, path, staging], SCRIPT_TIMEOUT_MS);
    if (result.code === 3) return { ok: false, reason: "not_a_regular_file" };
    const expected = sha256Hex(bytes);
    if (result.code !== 0 || !text(result.stdout).startsWith(`${expected} `)) throw new SessionError("place_failed", `exit ${String(result.code)}: ${result.stderr.trim()}`);
    return { ok: true, sha256: expected, bytes: bytes.length };
  }

  private live(): void {
    if (this.closed) throw new SessionError("session_closed", "the session's container is removed");
    if (this.submitted !== null) throw new SessionError("session_ended", "the attempt was submitted");
  }

  run(cmd: string): Promise<RunResult> {
    return this.serial(() => this.runNow(cmd));
  }

  private async runNow(cmd: string): Promise<RunResult> {
    this.live();
    const timeout = this.limits.commandTimeoutMs;
    const result = await this.exec(
      ["/opt/rbw/bin/rbw-launch", "--as", "app", "--cwd", APP_DIR, "--timeout-ms", String(timeout), "--max-stream-bytes", String(this.limits.outputBytes), "--", "/bin/sh", "-c", cmd],
      timeout,
    );
    const outcome: RunResult = { exit_code: result.code, stdout: text(result.stdout), stderr: result.stderr, timed_out: result.code === 124 || result.timedOut };
    this.event("run", { cmd_sha256: sha256Hex(Buffer.from(cmd)), exit_code: outcome.exit_code, timed_out: outcome.timed_out });
    return outcome;
  }

  readFile(path: string): Promise<ReadResult> {
    return this.serial(() => this.readFileNow(path));
  }

  private async readFileNow(path: string): Promise<ReadResult> {
    this.live();
    if (path === "" || path.includes("\0") || path.length > 4096) return { ok: false, reason: "bad_path" };
    const absolute = path.startsWith("/") ? path : `${APP_DIR}/${path}`;
    const limit = this.limits.readBytes;
    const result = await this.exec(
      ["/opt/rbw/bin/rbw-launch", "--as", "app", "--cwd", APP_DIR, "--timeout-ms", "30000", "--max-stream-bytes", String(limit + 1024), "--", "head", "-c", String(limit + 1), "--", absolute],
      30_000,
    );
    this.event("read_file", { path, exit_code: result.code });
    if (result.code !== 0) return { ok: false, reason: result.stderr.trim().slice(0, 500) || `exit ${String(result.code)}` };
    const truncated = result.stdout.length > limit;
    return { ok: true, content: text(truncated ? result.stdout.subarray(0, limit) : result.stdout), truncated };
  }

  /** A tracked path from what the agent wrote: relative to the app, or absolute under it. */
  private trackedPath(path: string): string | null {
    let relative = path.startsWith(`${APP_DIR}/`) ? path.slice(APP_DIR.length + 1) : path;
    if (relative.startsWith("/") || relative.includes("\0")) return null;
    relative = posix.normalize(relative);
    return this.writable.has(relative) ? relative : null;
  }

  writeFile(path: string, content: string): Promise<WriteResult> {
    return this.serial(() => this.writeFileNow(path, content));
  }

  private async writeFileNow(path: string, content: string): Promise<WriteResult> {
    this.live();
    const tracked = this.trackedPath(path);
    if (tracked === null) {
      this.event("write_file", { path, refused: "not_tracked" });
      return { ok: false, reason: "not_tracked" };
    }
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > this.limits.writeBytes) {
      this.event("write_file", { path: tracked, refused: "too_large", bytes: bytes.length });
      return { ok: false, reason: "too_large" };
    }
    const result = await this.place(tracked, bytes);
    this.event("write_file", { path: tracked, ...result });
    return result;
  }

  /**
   * rbw-check-cold, rbw-build-app, then rbw-start when the build passed. A warm tree before the
   * first build is an infrastructure error; before a rebuild it can come from what the agent left
   * (for example a pnpm store under /tmp), so it is the agent's failed rebuild, not an error.
   */
  private async buildAndStart(label: string, byAgent: boolean): Promise<RebuildResult> {
    const cold = await this.exec(["/opt/rbw/bin/rbw-check-cold"], SCRIPT_TIMEOUT_MS);
    if (cold.code !== 0) {
      const found = text(cold.stdout).trim();
      this.event("build_start", { label, refused: "not_cold", exit_code: cold.code });
      if (!byAgent) throw new SessionError("not_cold", found);
      return { ok: false, refused: "not_cold", build: { exit_code: null, output: tailText(`rbw-check-cold: the build would not be cold\n${found}\n`, this.limits.buildOutputBytes) }, start: null };
    }
    const build = await this.exec(["/opt/rbw/bin/rbw-build-app"], BUILD_TIMEOUT_MS);
    const buildOutput = `${text(build.stdout)}${build.stderr}`;
    let start: CommandResult | null = null;
    if (build.code === 0) {
      // rbw-start's launchers truncate both logs, so cursors from before it no longer apply.
      this.logGeneration += 1;
      start = await this.exec(["/opt/rbw/bin/rbw-start"], START_TIMEOUT_MS);
    }
    const raw = { label, build: { exit_code: build.code, stdout: text(build.stdout), stderr: build.stderr }, start: start === null ? null : { exit_code: start.code, stdout: text(start.stdout), stderr: start.stderr } };
    mkdirSync(join(this.work, "rebuilds"), { recursive: true });
    writeFileSync(join(this.work, "rebuilds", `${label}.json`), `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    const scrubbed = start === null ? null : scrubStartOutput(text(start.stdout), start.stderr);
    const result: RebuildResult = {
      ok: build.code === 0 && start?.code === 0,
      refused: null,
      build: { exit_code: build.code, output: tailText(buildOutput, this.limits.buildOutputBytes) },
      start: start === null || scrubbed === null ? null : { exit_code: start.code, output: scrubbed.text, withheld_lines: scrubbed.withheld },
    };
    this.event("build_start", { label, ok: result.ok, build_exit: build.code, start_exit: start?.code ?? null, withheld_lines: scrubbed?.withheld ?? 0 });
    return result;
  }

  rebuildRestart(): Promise<RebuildResult> {
    return this.serial(() => this.rebuildRestartNow());
  }

  private async rebuildRestartNow(): Promise<RebuildResult> {
    this.live();
    if (this.rebuilds >= this.limits.maxRebuilds) {
      this.event("rebuild_restart", { refused: "rebuild_cap" });
      return { ok: false, refused: "rebuild_cap", build: { exit_code: null, output: "" }, start: null };
    }
    this.rebuilds += 1;
    await this.execOk("stop", ["/opt/rbw/bin/rbw-stop"], STOP_TIMEOUT_MS);
    // rbw-stop ends only the kit's own launchers; anything the agent started outside rbw-launch's
    // process group (setsid, tmux) would keep serving old code or writing build outputs.
    await this.execOk("kill_app", scriptArgs(KILL_APP_SCRIPT, "rbw-kill-app"), SCRIPT_TIMEOUT_MS);
    await this.execOk("reset", scriptArgs(RESET_SCRIPT, "rbw-reset"), SCRIPT_TIMEOUT_MS);
    return this.buildAndStart(`rebuild-${String(this.rebuilds).padStart(2, "0")}`, true);
  }

  /** A slice from `offset` (null: the tail); `stale` marks a cursor from before the last start, read from 0. */
  private async slice(file: string, offset: number | null, stale: boolean): Promise<LogSlice & { next: number }> {
    const max = this.limits.logBytes;
    const result = await this.execOk("log_read", ["/bin/sh", "-c", LOG_SLICE_SCRIPT, "rbw-log", file, String(offset ?? -1), String(max)], 30_000);
    const newline = result.stdout.indexOf(0x0a);
    const [sizeText, startText] = text(result.stdout.subarray(0, newline)).split(" ");
    const size = Number(sizeText);
    const start = Number(startText);
    const body = result.stdout.subarray(newline + 1);
    return { text: text(body), size, more: start + body.length < size, restarted: stale || (offset !== null && offset > size), next: start + body.length };
  }

  serverLogs(cursor: LogCursor | null = null): Promise<ServerLogsResult> {
    return this.serial(() => this.serverLogsNow(cursor));
  }

  private async serverLogsNow(cursor: LogCursor | null): Promise<ServerLogsResult> {
    this.live();
    if (!this.options.serverLogs) {
      this.event("server_logs", { refused: "not_in_this_arm" });
      return { ok: false, reason: "server_logs_unavailable" };
    }
    const stale = cursor !== null && cursor.generation !== this.logGeneration;
    const umami = await this.slice(LOG_FILES.umami, stale ? 0 : (cursor?.umami ?? null), stale);
    const postgres = await this.slice(LOG_FILES.postgres, stale ? 0 : (cursor?.postgres ?? null), stale);
    this.event("server_logs", { umami_bytes: Buffer.byteLength(umami.text), postgres_bytes: Buffer.byteLength(postgres.text) });
    const { next: umamiNext, ...umamiSlice } = umami;
    const { next: postgresNext, ...postgresSlice } = postgres;
    return { ok: true, umami: umamiSlice, postgres: postgresSlice, cursor: { generation: this.logGeneration, umami: umamiNext, postgres: postgresNext } };
  }

  /** submit(): the attempt's diff against the neutral commit; the files go under <work>/submission. */
  submit(): Promise<SubmitResult> {
    return this.end("submit");
  }

  /** Ends the attempt on submit or on a cap the solver enforces; extracts the diff once. */
  end(reason: "submit" | "cap"): Promise<SubmitResult> {
    return this.serial(() => this.endNow(reason));
  }

  private async endNow(reason: "submit" | "cap"): Promise<SubmitResult> {
    if (this.submitted !== null) return this.submitted;
    if (this.closed) throw new SessionError("session_closed", "the session's container is removed");
    const current = await readContainerTracked(this.deps.docker, this.container, this.scoped);
    const result = submission(this.projection, compareTracked(this.projection, this.scoped, current, this.target), this.target);
    const dir = join(this.work, "submission");
    mkdirSync(dir, { recursive: true });
    const entry = current.get(this.target);
    if (result.target_sha256 !== null && entry !== undefined) writeFileSync(join(dir, "target.bin"), entry.bytes);
    writeFileSync(join(dir, "target.patch"), result.target_patch);
    writeFileSync(join(dir, "submission.json"), `${JSON.stringify({ ended_by: reason, target_path: this.target, image_digest: this.digest, ...result }, null, 2)}\n`);
    this.event("submit", { ended_by: reason, scope: result.scope, changed: result.changed.length, target_sha256: result.target_sha256 });
    this.submitted = result;
    return result;
  }

  /**
   * Copies the runtime logs out (harness capture, both arms) and removes the container. Idempotent.
   * A failed copy keeps the container (the logs' only copy) and throws; calling close() again retries.
   */
  close(): Promise<void> {
    return this.serial(() => this.closeNow());
  }

  private async closeNow(): Promise<void> {
    if (this.removed) return;
    this.closed = true;
    if (!this.started) {
      this.removed = true;
      return;
    }
    this.logCopies += 1;
    // A retry copies into a fresh directory: docker cp nests into a destination that already exists.
    const destination = join(this.work, this.logCopies === 1 ? "logs" : `logs-retry-${String(this.logCopies - 1)}`);
    const logs = await this.deps.docker.run(["cp", `${this.container}:${LOGS_DIR}`, destination], { timeoutMs: SCRIPT_TIMEOUT_MS });
    if (logs.code !== 0) {
      this.event("closed", { logs_copied: false, removed: false });
      throw new SessionError("logs_copy_failed", `kept container ${this.container} for its runtime logs: ${logs.stderr.trim()}`);
    }
    const removed = await this.deps.docker.run(["rm", "--force", this.container], { timeoutMs: SCRIPT_TIMEOUT_MS });
    this.event("closed", { logs_copied: true, logs_dir: destination.slice(this.work.length + 1), removed: removed.code === 0 });
    this.removed = true;
    if (removed.code !== 0) throw new SessionError("container_remove_failed", removed.stderr.trim());
  }
}
