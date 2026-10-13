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
import { RESET_SCRIPT, SESSION_STATE_DIR, SNAPSHOT_SCRIPT, kitBuildOutputs, scriptArgs } from "./reset.ts";
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
const INCOMING = `${SESSION_STATE_DIR}/incoming`;
const LOGS_DIR = "/var/lib/rbw/logs";
const LOG_FILES = { umami: `${LOGS_DIR}/umami.stderr.log`, postgres: `${LOGS_DIR}/postgres.stderr.log` } as const;

/** Writes the incoming file over a tracked file in place, so the file keeps its owner and mode. */
const PLACE_SCRIPT = `set -eu
target="${APP_DIR}/$1"
if [ -L "$target" ] || [ ! -f "$target" ]; then rm -f ${INCOMING}; echo "not a regular file" >&2; exit 3; fi
cat ${INCOMING} > "$target"
rm -f ${INCOMING}
sha256sum "$target"
`;

/** Prints "<size> <start>" and then the log's bytes from <start>, at most <max>. A negative offset asks for the tail. */
const LOG_SLICE_SCRIPT = `set -eu
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
  private rebuilds = 0;
  private started = false;
  private submitted: SubmitResult | null = null;
  private closed = false;

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
      await session.close();
      throw error;
    }
  }

  private event(op: string, detail: Record<string, unknown> = {}): void {
    appendFileSync(join(this.work, "events.jsonl"), `${JSON.stringify({ at: new Date(this.deps.clock.now()).toISOString(), op, ...detail })}\n`);
  }

  private async prepare(): Promise<{ digest: string; audit: AuditResult; planted: Buffer }> {
    try {
      const inputs = loadCopyInputs(this.options);
      const digest = await inspectImage(this.deps.docker, this.options.image);
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
      this.writable = new Set(this.tracked);
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
    this.started = true;
    if (created.code !== 0) throw new SessionError("container_start_failed", created.stderr.trim());
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
    const initial = await this.buildAndStart("initial");
    if (!initial.ok) throw new SessionError("initial_start_failed", initial.start?.output ?? initial.build.output);
    return initial;
  }

  /** Places bytes over a tracked file through a staging file, as root, keeping its owner and mode. */
  private async place(path: string, bytes: Buffer): Promise<WriteResult> {
    const incoming = join(this.work, "incoming");
    mkdirSync(incoming, { recursive: true });
    const host = join(incoming, `${String(this.deps.clock.now())}-${sha256Hex(bytes).slice(0, 16)}`);
    writeFileSync(host, bytes, { mode: 0o644 });
    const copied = await this.deps.docker.run(["cp", host, `${this.container}:${INCOMING}`], { timeoutMs: SCRIPT_TIMEOUT_MS });
    if (copied.code !== 0) throw new SessionError("copy_in_failed", copied.stderr.trim());
    const result = await this.exec(["/bin/sh", "-c", PLACE_SCRIPT, "rbw-place", path], SCRIPT_TIMEOUT_MS);
    if (result.code === 3) return { ok: false, reason: "not_a_regular_file" };
    const expected = sha256Hex(bytes);
    if (result.code !== 0 || !text(result.stdout).startsWith(`${expected} `)) throw new SessionError("place_failed", `exit ${String(result.code)}: ${result.stderr.trim()}`);
    return { ok: true, sha256: expected, bytes: bytes.length };
  }

  private live(): void {
    if (this.closed) throw new SessionError("session_closed", "the session's container is removed");
    if (this.submitted !== null) throw new SessionError("session_ended", "the attempt was submitted");
  }

  async run(cmd: string): Promise<RunResult> {
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

  async readFile(path: string): Promise<ReadResult> {
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

  async writeFile(path: string, content: string): Promise<WriteResult> {
    this.live();
    const tracked = this.trackedPath(path);
    if (tracked === null) {
      this.event("write_file", { path, refused: "not_tracked" });
      return { ok: false, reason: "not_tracked" };
    }
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > this.limits.writeBytes) return { ok: false, reason: "too_large" };
    const result = await this.place(tracked, bytes);
    this.event("write_file", { path: tracked, ...result });
    return result;
  }

  private async buildAndStart(label: string): Promise<RebuildResult> {
    const cold = await this.exec(["/opt/rbw/bin/rbw-check-cold"], SCRIPT_TIMEOUT_MS);
    if (cold.code !== 0) throw new SessionError("not_cold", text(cold.stdout).trim());
    const build = await this.exec(["/opt/rbw/bin/rbw-build-app"], BUILD_TIMEOUT_MS);
    const buildOutput = `${text(build.stdout)}${build.stderr}`;
    let start: CommandResult | null = null;
    if (build.code === 0) start = await this.exec(["/opt/rbw/bin/rbw-start"], START_TIMEOUT_MS);
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

  async rebuildRestart(): Promise<RebuildResult> {
    this.live();
    if (this.rebuilds >= this.limits.maxRebuilds) {
      this.event("rebuild_restart", { refused: "rebuild_cap" });
      return { ok: false, refused: "rebuild_cap", build: { exit_code: null, output: "" }, start: null };
    }
    this.rebuilds += 1;
    await this.execOk("stop", ["/opt/rbw/bin/rbw-stop"], STOP_TIMEOUT_MS);
    await this.execOk("reset", scriptArgs(RESET_SCRIPT, "rbw-reset"), SCRIPT_TIMEOUT_MS);
    return this.buildAndStart(`rebuild-${String(this.rebuilds).padStart(2, "0")}`);
  }

  private async slice(file: string, offset: number | null): Promise<LogSlice & { next: number }> {
    const max = this.limits.logBytes;
    const result = await this.execOk("log_read", ["/bin/sh", "-c", LOG_SLICE_SCRIPT, "rbw-log", file, String(offset ?? -1), String(max)], 30_000);
    const newline = result.stdout.indexOf(0x0a);
    const [sizeText, startText] = text(result.stdout.subarray(0, newline)).split(" ");
    const size = Number(sizeText);
    const start = Number(startText);
    const body = result.stdout.subarray(newline + 1);
    return { text: text(body), size, more: start + body.length < size, restarted: offset !== null && offset > size, next: start + body.length };
  }

  async serverLogs(cursor: LogCursor | null = null): Promise<ServerLogsResult> {
    this.live();
    if (!this.options.serverLogs) {
      this.event("server_logs", { refused: "not_in_this_arm" });
      return { ok: false, reason: "server_logs_unavailable" };
    }
    const umami = await this.slice(LOG_FILES.umami, cursor?.umami ?? null);
    const postgres = await this.slice(LOG_FILES.postgres, cursor?.postgres ?? null);
    this.event("server_logs", { umami_bytes: Buffer.byteLength(umami.text), postgres_bytes: Buffer.byteLength(postgres.text) });
    const { next: umamiNext, ...umamiSlice } = umami;
    const { next: postgresNext, ...postgresSlice } = postgres;
    return { ok: true, umami: umamiSlice, postgres: postgresSlice, cursor: { umami: umamiNext, postgres: postgresNext } };
  }

  /** submit(): the attempt's diff against the neutral commit; the files go under <work>/submission. */
  async submit(): Promise<SubmitResult> {
    return this.end("submit");
  }

  /** Ends the attempt on submit or on a cap the solver enforces; extracts the diff once. */
  async end(reason: "submit" | "cap"): Promise<SubmitResult> {
    if (this.submitted !== null) return this.submitted;
    if (this.closed) throw new SessionError("session_closed", "the session's container is removed");
    const current = await readContainerTracked(this.deps.docker, this.container, this.tracked);
    const result = submission(this.projection, compareTracked(this.projection, this.tracked, current, this.target), this.target);
    const dir = join(this.work, "submission");
    mkdirSync(dir, { recursive: true });
    const entry = current.get(this.target);
    if (result.target_sha256 !== null && entry !== undefined) writeFileSync(join(dir, "target.bin"), entry.bytes);
    writeFileSync(join(dir, "target.patch"), result.target_patch);
    writeFileSync(join(dir, "submission.json"), `${JSON.stringify({ ended_by: reason, target_path: this.target, ...result }, null, 2)}\n`);
    this.event("submit", { ended_by: reason, scope: result.scope, changed: result.changed.length, target_sha256: result.target_sha256 });
    this.submitted = result;
    return result;
  }

  /** Copies the runtime logs out (harness capture, both arms) and removes the container. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.started) return;
    const logs = await this.deps.docker.run(["cp", `${this.container}:${LOGS_DIR}`, join(this.work, "logs")], { timeoutMs: SCRIPT_TIMEOUT_MS });
    const removed = await this.deps.docker.run(["rm", "--force", this.container], { timeoutMs: SCRIPT_TIMEOUT_MS });
    this.event("closed", { logs_copied: logs.code === 0, removed: removed.code === 0 });
    if (removed.code !== 0) throw new SessionError("container_remove_failed", removed.stderr.trim());
  }
}
