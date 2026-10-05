// The original suite's runner environment, and the identity check that must pass before the
// destructive suite may target an app copy.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { WRAPPER_CONFIG_NAME } from "./harness.ts";
import { PLAYWRIGHT_VERSION } from "./pinned.ts";

/** A fixed PATH: the runner is started by absolute path and needs nothing else from the host. */
export const RUNNER_PATH = "/usr/local/bin:/usr/bin:/bin";

/** Placeholders for per-trial paths, so a run's environment manifest equals the frozen one. */
export interface RunnerPaths {
  suite_dir: string;
  report_file: string;
}

export interface EnvironmentManifest {
  /** Variables set for both the `--list` run and the real run. Values may hold `{suite_dir}` or `{report_file}`. */
  variables: Record<string, string>;
  /** Variables set only for the real run, and only after the app copy's identity has been checked. */
  after_identity_check: Record<string, string>;
  /** Variables that are never set, recorded so the manifest states it. */
  absent: string[];
  run_args: string[];
  list_args: string[];
  /** The Playwright CLI, relative to the suite copy, reached through the copy's node_modules link. */
  playwright_cli: string;
  playwright_version: string;
  node_version: string;
}

export function suiteEnvironmentManifest(options: { baseUrl: string; nodeVersion: string }): EnvironmentManifest {
  const common = [`--config=${WRAPPER_CONFIG_NAME}`, "--workers=1", "--retries=0", "--max-failures=0"];
  return {
    variables: {
      API_COVERAGE: "report",
      FORCE_COLOR: "0",
      HOME: "{suite_dir}",
      PATH: RUNNER_PATH,
      PLAYWRIGHT_BASE_URL: options.baseUrl,
      PLAYWRIGHT_JSON_OUTPUT_FILE: "{report_file}",
      TZ: "UTC",
    },
    after_identity_check: { API_ALLOW_DESTRUCTIVE: "1" },
    absent: ["API_SKIP_SEED", "CI", "NODE_OPTIONS", "UMAMI_TEST_DB", "UMAMI_TEST_PORT"],
    run_args: ["test", ...common],
    list_args: ["test", "--list", ...common],
    playwright_cli: "node_modules/@playwright/test/cli.js",
    playwright_version: PLAYWRIGHT_VERSION,
    node_version: options.nodeVersion,
  };
}

function materialize(variables: Record<string, string>, paths: RunnerPaths): Record<string, string> {
  return Object.fromEntries(
    Object.entries(variables).map(([name, value]) => [
      name,
      value.replaceAll("{suite_dir}", paths.suite_dir).replaceAll("{report_file}", paths.report_file),
    ]),
  );
}

/** Proof that the base URL points at this copy's own app process. Only the identity checks create one. */
export interface VerifiedIdentity {
  kind: "kit" | "external";
  base_url: string;
  host: string;
  port: number;
  /** The process that owns the listening socket; null for an external app. */
  pid: number | null;
}

/** The environment for `--list`, which never contacts the app, so it never opts in to destructive runs. */
export function listProcessEnv(manifest: EnvironmentManifest, paths: RunnerPaths): Record<string, string> {
  return materialize(manifest.variables, paths);
}

/**
 * The environment for the real suite run, built from nothing but the manifest. API_ALLOW_DESTRUCTIVE
 * is added only when an identity check has passed.
 */
export function suiteProcessEnv(
  manifest: EnvironmentManifest,
  paths: RunnerPaths,
  identity: VerifiedIdentity | null,
): Record<string, string> {
  const env = materialize(manifest.variables, paths);
  if (identity === null) return env;
  return { ...env, ...manifest.after_identity_check };
}

export interface ListeningSocket {
  host: string;
  port: number;
  inode: number;
  /** The UID that created the socket, from /proc/net/tcp's uid column. */
  uid: number;
}

export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgrp: number;
  /** The effective UID from /proc/<pid>/status; null when the file has no Uid line. */
  uid: number | null;
  /** False for a zombie or dead process, which holds no sockets. */
  alive: boolean;
}

/**
 * What the identity check reads. Injected so tests need no real processes. Every source is readable
 * by root without ptrace access to other users' processes, which Docker's default capabilities
 * do not grant: /proc/<pid>/fd links are never followed.
 */
export interface ProcView {
  listeningSockets(): Promise<ListeningSocket[]>;
  processes(): Promise<ProcessEntry[]>;
  /** The PID in the kit's /run/rbw/<name>.pid, or null when there is none. */
  pidFile(name: string): Promise<number | null>;
}

/**
 * Checks that the base URL names the expected loopback host and port, and that the socket
 * listening there belongs to the app this trial started. The kit's rbw-start runs in the group the
 * driver started (`startGroup`), writes the Umami launcher's PID to /run/rbw/umami.pid and leaves
 * the launcher in that group; the launcher starts Umami as rbw-app in a new process group whose
 * leader is its child. So:
 *  - every socket listening on the port was created by rbw-app;
 *  - the launcher named by the PID file is alive and in the start group;
 *  - a live child of the launcher runs as rbw-app and leads its own group;
 *  - every live rbw-app process is in that group.
 * Together these place the listener in the group this trial's rbw-start launched, without reading
 * which process holds the socket's fd.
 */
export async function verifyKitIdentity(options: {
  baseUrl: string;
  expectedHost: string;
  expectedPort: number;
  startGroup: number;
  appUid: number;
  launcher: string;
  proc: ProcView;
}): Promise<VerifiedIdentity | null> {
  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    return null;
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (url.protocol !== "http:" || url.hostname !== options.expectedHost || port !== options.expectedPort) return null;
  const sockets = (await options.proc.listeningSockets()).filter(
    (socket) => socket.port === port && [options.expectedHost, "0.0.0.0", "::"].includes(socket.host),
  );
  if (sockets.length === 0 || sockets.some((socket) => socket.uid !== options.appUid)) return null;
  const launcherPid = await options.proc.pidFile(options.launcher);
  if (launcherPid === null) return null;
  const live = (await options.proc.processes()).filter((entry) => entry.alive);
  const launcher = live.find((entry) => entry.pid === launcherPid);
  if (launcher?.pgrp !== options.startGroup) return null;
  const app = live.find((entry) => entry.ppid === launcher.pid && entry.pgrp === entry.pid && entry.uid === options.appUid);
  if (app === undefined) return null;
  if (live.some((entry) => entry.uid === options.appUid && entry.pgrp !== app.pgrp)) return null;
  return { kind: "kit", base_url: options.baseUrl, host: url.hostname, port, pid: app.pid };
}

/** Reads the parent, the process group and the state from /proc/<pid>/stat; the command name may hold spaces and parentheses. */
export function parseProcStat(pid: number, stat: string): Omit<ProcessEntry, "uid"> | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  // Fields after the parenthesised command name: state, ppid, pgrp, ...
  const fields = stat.slice(close + 2).split(" ");
  const state = fields[0] ?? "";
  const ppid = Number(fields[1]);
  const pgrp = Number(fields[2]);
  if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgrp) || fields.length <= 2) return null;
  return { pid, ppid, pgrp, alive: state !== "Z" && state !== "X" };
}

/** The effective UID, the second value of /proc/<pid>/status's Uid line. */
export function parseProcStatusUid(status: string): number | null {
  const match = /^Uid:\s+\d+\s+(\d+)/m.exec(status);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Development only: an app the driver did not start, such as a test stack on the host. The
 * identity is the configured base URL answering its heartbeat; no process check is possible.
 */
export async function verifyExternalIdentity(options: {
  baseUrl: string;
  heartbeat: () => Promise<boolean>;
}): Promise<VerifiedIdentity | null> {
  const url = new URL(options.baseUrl);
  if (!(await options.heartbeat())) return null;
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return { kind: "external", base_url: options.baseUrl, host: url.hostname, port, pid: null };
}

export function parseProcNetTcp(text: string, ipv6: boolean): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const local = fields[1];
    const state = fields[3];
    const uid = fields[7];
    const inode = fields[9];
    if (local === undefined || state !== "0A" || uid === undefined || inode === undefined) continue;
    const [address, portHex] = local.split(":");
    if (address === undefined || portHex === undefined) continue;
    sockets.push({ host: decodeAddress(address, ipv6), port: Number.parseInt(portHex, 16), inode: Number(inode), uid: Number(uid) });
  }
  return sockets;
}

/** Decodes /proc/net/tcp's little-endian hex addresses. IPv6 loopback becomes "::1". */
function decodeAddress(hex: string, ipv6: boolean): string {
  if (!ipv6) {
    const bytes = (hex.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)).reverse();
    return bytes.join(".");
  }
  if (hex === "00000000000000000000000001000000") return "::1";
  if (hex === "00000000000000000000000000000000") return "::";
  return hex;
}

/** A process can end between listing /proc and reading its files; only that case is tolerated. */
function goneOr<T>(fallback: T): (error: unknown) => T {
  return (error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return fallback;
    throw error;
  };
}

/** The files the /proc reader uses. Injected so tests can model another user's /proc entries. */
export interface ProcFiles {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
}

/** Reads /proc and the kit's PID files through `files`. */
export function procView(files: ProcFiles, runDir: string): ProcView {
  return {
    async listeningSockets() {
      const v4 = await files.readFile("/proc/net/tcp");
      const v6 = await files.readFile("/proc/net/tcp6").catch(goneOr(""));
      return [...parseProcNetTcp(v4, false), ...parseProcNetTcp(v6, true)];
    },
    async processes() {
      const entries: ProcessEntry[] = [];
      for (const name of await files.readdir("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        const stat = await files.readFile(join("/proc", name, "stat")).catch(goneOr(null));
        const status = await files.readFile(join("/proc", name, "status")).catch(goneOr(null));
        const entry = stat === null || status === null ? null : parseProcStat(Number(name), stat);
        if (entry !== null && status !== null) entries.push({ ...entry, uid: parseProcStatusUid(status) });
      }
      return entries;
    },
    async pidFile(name) {
      const text = await files.readFile(join(runDir, `${name}.pid`)).catch(goneOr(null));
      if (text === null) return null;
      const pid = Number(text.trim());
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    },
  };
}

/** The real files. */
export const realProcFiles: ProcFiles = { readFile: (path) => readFile(path, "utf8"), readdir: (path) => readdir(path) };
