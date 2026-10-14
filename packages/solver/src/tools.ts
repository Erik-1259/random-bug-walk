// The solver's tools and the session interface that runs them. The session runner (a separate
// package) implements SolverSession against one container; this module defines what the model
// sees: the tool list per arm, input validation, byte caps, the rebuild cap, and the scrub that
// keeps runtime log tails out of rebuild_restart in both arms.
import { tool, zodSchema } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { AttemptCaps } from "./profile.ts";
import { TOOL_OUTPUT_CAPS } from "./profile.ts";

/** `off`: no server_logs tool. `on`: server_logs added. Nothing else differs between arms. */
export type Arm = "off" | "on";
export const ARMS: readonly Arm[] = ["off", "on"];

export const TOOL_NAMES = ["bash", "read_file", "write_file", "rebuild_restart", "submit", "server_logs"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface CommandResult {
  /** Null when the command was killed (for example at its timeout). */
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

export interface RebuildResult {
  /**
   * rbw-build-app after the cold-build reset: its exit status and its own stdout and stderr,
   * unchanged. Its stdout carries the build's logs, under `--- build stdout (<path>)` and
   * `--- build stderr (<path>)` headers, then `build_exit=` and `build_wall_ms=` lines; its stderr
   * carries only its precheck and font-server messages. rebuildReport cuts the sections out.
   */
  build: { exit_code: number; stdout: string; stderr: string };
  /** rbw-start's exit status and output; null when the build failed and nothing was started. */
  start: { exit_code: number; stdout: string; stderr: string } | null;
}

export interface ServerLogsPage {
  /** Log text from the cursor (or the tail when there is none), at most the requested bytes. */
  text: string;
  /** Opaque; passing it back returns what was written after this page. */
  next_cursor: string;
  /** True when bytes between the cursor and the returned text were skipped. */
  truncated: boolean;
}

export type FileResult = { ok: true; content: string } | { ok: false; error: string };
export type WriteResult = { ok: true } | { ok: false; error: string };

/**
 * One attempt's container, implemented by the session runner. Paths are relative to the app tree.
 * A thrown error is an infrastructure error: the attempt stops and is rerun under the rerun rule.
 */
export interface SolverSession {
  /** Runs `command` with sh as the unprivileged app user, in the app tree. */
  bash(command: string, options: { timeoutMs: number }): Promise<CommandResult>;
  readFile(path: string): Promise<FileResult>;
  /** Written by the harness, only to tracked files under the app tree; anything else is an error. */
  writeFile(path: string, content: string): Promise<WriteResult>;
  /** rbw-stop, the cold-build reset, rbw-build-app, then rbw-start when the build passed. */
  rebuildRestart(): Promise<RebuildResult>;
  /** A byte-capped page of umami.stderr.log and postgres.stderr.log. Called in the on arm only. */
  serverLogs(request: { cursor: string | null; maxBytes: number }): Promise<ServerLogsPage>;
}

const RelativePath = z
  .string()
  .min(1)
  .max(1024)
  .describe("A path relative to the app's root directory, such as src/lib/date.ts");

const INPUT_SCHEMAS = {
  bash: z.strictObject({ command: z.string().min(1).max(8_000).describe("A shell command, run with sh in the app's root directory") }),
  read_file: z.strictObject({ path: RelativePath }),
  write_file: z.strictObject({ path: RelativePath, content: z.string().describe("The file's complete new contents") }),
  rebuild_restart: z.strictObject({}),
  submit: z.strictObject({ summary: z.string().max(4_000).describe("A short description of the fix") }),
  server_logs: z.strictObject({
    cursor: z.string().max(256).optional().describe("The next_cursor of an earlier call; omit it to read the latest lines"),
  }),
} as const;

const DESCRIPTIONS: Record<ToolName, string> = {
  bash: "Run a shell command in the app's root directory as an unprivileged user. Returns the exit code, stdout and stderr, each cut to a byte limit.",
  read_file: "Read a file of the app, by a path relative to the app's root directory.",
  write_file: "Replace the contents of an existing tracked file of the app. Creating new files is not allowed.",
  rebuild_restart:
    "Stop the app, rebuild it from a clean state and start it again. Returns the build's exit status and the end of its output, and whether the app started. Builds take minutes.",
  submit: "Finish the attempt. The current state of the files is the fix that is graded.",
  server_logs:
    "Read the running app's server logs (the app server's and the database's error output). Without a cursor it returns the latest lines; with the next_cursor of an earlier call it returns what was written since.",
};

/** The tools of one arm, in a fixed order. The on arm adds server_logs and nothing else. */
export function armToolNames(arm: Arm): ToolName[] {
  const base: ToolName[] = ["bash", "read_file", "write_file", "rebuild_restart", "submit"];
  return arm === "on" ? [...base, "server_logs"] : base;
}

/** The AI SDK tool set of one arm. No tool has `execute`: the loop runs each call itself. */
export function armToolSet(arm: Arm): ToolSet {
  const set: ToolSet = {};
  for (const name of armToolNames(arm)) {
    set[name] = tool({ description: DESCRIPTIONS[name], inputSchema: zodSchema(INPUT_SCHEMAS[name] as z.ZodType<Record<string, unknown>>) });
  }
  return set;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/** The first `maxBytes` bytes of `text`, with a marker when anything was cut. */
export function headBytes(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) {
    return text;
  }
  return `${decoder.decode(bytes.subarray(0, maxBytes))}\n[cut: showing the first ${String(maxBytes)} of ${String(bytes.length)} bytes]`;
}

/** The last `maxBytes` bytes of `text`, with a marker when anything was cut. */
export function tailBytes(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) {
    return text;
  }
  return `[cut: showing the last ${String(maxBytes)} of ${String(bytes.length)} bytes]\n${decoder.decode(bytes.subarray(bytes.length - maxBytes))}`;
}

/** The runtime logs rbw-start's fail() prints the tail of, and that only server_logs may show. */
const RUNTIME_LOG = /^--- \/var\/lib\/rbw\/logs\/(?:umami|postgres)\.[a-z]+\.log\s*$/;

/**
 * Removes every runtime log section: from a `--- /var/lib/rbw/logs/<umami|postgres>.*.log` header
 * line up to the next `--- ` header line or the end. Each removed section leaves one marker line.
 */
export function scrubRuntimeLogs(text: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (RUNTIME_LOG.test(line)) {
      skipping = true;
      out.push("[runtime log lines withheld]");
      continue;
    }
    if (skipping && line.startsWith("--- ")) {
      skipping = false;
    }
    if (!skipping) {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** The only rbw-start output lines the model sees: its own messages and timings, never log text. */
const START_STATUS = /^(?:rbw-start: |postgres_ready_ms=|ready_ms=|listening )/;

const BUILD_STDOUT_HEADER = /^--- build stdout \(.*\)$/;
const BUILD_STDERR_HEADER = /^--- build stderr \(.*\)$/;
const BUILD_TRAILER = /^build_(?:exit|wall_ms)=/;

/**
 * The build's own stdout and stderr logs, cut out of rbw-build-app's stdout. Without the headers
 * (the build never started), the whole stdout counts as the build's stdout.
 */
export function buildLogSections(stdout: string): { stdout: string; stderr: string } {
  const lines = stdout.split("\n");
  const out = lines.findIndex((line) => BUILD_STDOUT_HEADER.test(line));
  const err = lines.findIndex((line, i) => i > out && BUILD_STDERR_HEADER.test(line));
  if (out === -1 || err === -1) {
    return { stdout, stderr: "" };
  }
  let end = lines.length;
  while (end > err + 1 && (BUILD_TRAILER.test(lines[end - 1] ?? "") || lines[end - 1] === "")) {
    end -= 1;
  }
  return { stdout: lines.slice(out + 1, err).join("\n"), stderr: lines.slice(err + 1, end).join("\n") };
}

/**
 * What rebuild_restart shows the model: exit statuses, the tails of the build's stdout and stderr
 * logs, rbw-build-app's own messages, and rbw-start's status lines.
 */
export function rebuildReport(result: RebuildResult): string {
  const sections = buildLogSections(result.build.stdout);
  const show = (text: string) => tailBytes(scrubRuntimeLogs(text), TOOL_OUTPUT_CAPS.build_log_bytes);
  const lines = [
    `build_exit_code: ${String(result.build.exit_code)}`,
    "--- build stdout",
    show(sections.stdout),
    "--- build stderr",
    show(sections.stderr),
  ];
  if (result.build.stderr.trim() !== "") {
    lines.push("--- rbw-build-app messages", show(result.build.stderr));
  }
  if (result.start === null) {
    lines.push("start: not run (the build failed)");
    return lines.join("\n");
  }
  // rbw-start appends runtime log tails under `--- <log>` headers when it fails; those lines go
  // before the status filter, so a log line shaped like a status line never reaches the model.
  const startText = `${scrubRuntimeLogs(result.start.stdout)}\n${scrubRuntimeLogs(result.start.stderr)}`;
  const startLines = startText.split("\n").filter((line) => line !== "");
  const shown = startLines.filter((line) => START_STATUS.test(line));
  const withheld = startLines.length - shown.length;
  lines.push(`start_exit_code: ${String(result.start.exit_code)}`, "--- start status", ...shown);
  if (withheld > 0) {
    lines.push(`[${String(withheld)} other start output lines withheld]`);
  }
  return lines.join("\n");
}

function commandReport(result: CommandResult): string {
  const cap = TOOL_OUTPUT_CAPS.bash_output_bytes;
  return [
    `exit_code: ${result.exit_code === null ? "none (killed)" : String(result.exit_code)}${result.timed_out ? " (timed out)" : ""}`,
    "--- stdout",
    tailBytes(result.stdout, cap),
    "--- stderr",
    tailBytes(result.stderr, cap),
  ].join("\n");
}

/** A relative path inside the app tree: no leading slash, no `..`, `.` or empty segment, no NUL. */
export function isAppPath(path: string): boolean {
  if (path.startsWith("/") || path.includes("\0") || path.includes("\\")) {
    return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Per-attempt tool state: the rebuild count and per-tool call counts. */
export interface ToolState {
  rebuilds: number;
  calls: Record<ToolName, number>;
  /** Every bash command in order, for the contamination check. */
  bash_commands: string[];
  /** Every read_file and write_file path in order, refused ones included, for the contamination check. */
  file_paths: string[];
}

export function newToolState(): ToolState {
  return {
    rebuilds: 0,
    calls: { bash: 0, read_file: 0, write_file: 0, rebuild_restart: 0, submit: 0, server_logs: 0 },
    bash_commands: [],
    file_paths: [],
  };
}

export interface ToolOutcome {
  /** The text the model receives as the tool result. */
  output: string;
  /** True when the call was submit. */
  submitted: boolean;
  /** The submit summary, when submitted. */
  summary: string | null;
}

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Runs one validated tool call of `arm` against the session. A call to a tool outside the arm,
 * or with invalid input, is answered with an error text and never reaches the session.
 */
export async function runTool(
  arm: Arm,
  name: string,
  input: unknown,
  session: SolverSession,
  state: ToolState,
  caps: AttemptCaps,
): Promise<ToolOutcome> {
  const reply = (output: string): ToolOutcome => ({ output, submitted: false, summary: null });
  if (!isToolName(name) || !armToolNames(arm).includes(name)) {
    return reply(`error: there is no tool named ${name}`);
  }
  const parsed = INPUT_SCHEMAS[name].safeParse(input);
  if (!parsed.success) {
    return reply(`error: invalid input for ${name}: ${z.prettifyError(parsed.error)}`);
  }
  state.calls[name] += 1;
  switch (name) {
    case "bash": {
      const { command } = INPUT_SCHEMAS.bash.parse(input);
      state.bash_commands.push(command);
      return reply(commandReport(await session.bash(command, { timeoutMs: TOOL_OUTPUT_CAPS.bash_timeout_ms })));
    }
    case "read_file": {
      const { path } = INPUT_SCHEMAS.read_file.parse(input);
      state.file_paths.push(path);
      if (!isAppPath(path)) {
        return reply("error: the path must be relative to the app's root directory, without . or .. segments");
      }
      const result = await session.readFile(path);
      return reply(result.ok ? headBytes(result.content, TOOL_OUTPUT_CAPS.read_file_bytes) : `error: ${result.error}`);
    }
    case "write_file": {
      const { path, content } = INPUT_SCHEMAS.write_file.parse(input);
      state.file_paths.push(path);
      if (!isAppPath(path)) {
        return reply("error: the path must be relative to the app's root directory, without . or .. segments");
      }
      const result = await session.writeFile(path, content);
      return reply(result.ok ? `wrote ${path} (${String(encoder.encode(content).length)} bytes)` : `error: ${result.error}`);
    }
    case "rebuild_restart": {
      if (state.rebuilds >= caps.max_rebuilds) {
        return reply(`error: the rebuild limit of ${String(caps.max_rebuilds)} is reached; the app was not rebuilt`);
      }
      state.rebuilds += 1;
      return reply(rebuildReport(await session.rebuildRestart()));
    }
    case "server_logs": {
      const { cursor } = INPUT_SCHEMAS.server_logs.parse(input);
      const page = await session.serverLogs({ cursor: cursor ?? null, maxBytes: TOOL_OUTPUT_CAPS.server_logs_bytes });
      const text = tailBytes(page.text, TOOL_OUTPUT_CAPS.server_logs_bytes);
      return reply(`next_cursor: ${page.next_cursor}${page.truncated ? "\n[earlier lines skipped]" : ""}\n--- logs\n${text}`);
    }
    case "submit": {
      const { summary } = INPUT_SCHEMAS.submit.parse(input);
      return { output: "submitted", submitted: true, summary };
    }
  }
}
