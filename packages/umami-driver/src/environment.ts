// The original suite's runner environment, and the identity check that must pass before the
// destructive suite may target an app copy.
import { readdir, readFile, readlink } from "node:fs/promises";
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
}

export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgrp: number;
}

/** What the identity check reads from /proc. Injected so tests need no real processes. */
export interface ProcView {
  listeningSockets(): Promise<ListeningSocket[]>;
  processes(): Promise<ProcessEntry[]>;
  socketInodes(pid: number): Promise<number[]>;
}

/**
 * Checks that the base URL names the expected loopback host and port, and that the socket
 * listening there belongs to the app the driver started. The kit's rbw-start runs in the group the
 * driver started (`startGroup`) and leaves Umami's launcher there; the launcher starts Umami in a
 * new process group of its own. So the listener's group leader must be a child of a process in
 * the start group.
 */
export async function verifyKitIdentity(options: {
  baseUrl: string;
  expectedHost: string;
  expectedPort: number;
  startGroup: number;
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
  if (sockets.length === 0) return null;
  const wanted = new Set(sockets.map((socket) => socket.inode));
  const processes = await options.proc.processes();
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  for (const entry of processes) {
    const leader = byPid.get(entry.pgrp);
    const launcher = leader === undefined ? undefined : byPid.get(leader.ppid);
    if (launcher?.pgrp !== options.startGroup) continue;
    const inodes = await options.proc.socketInodes(entry.pid);
    if (inodes.some((inode) => wanted.has(inode))) {
      return { kind: "kit", base_url: options.baseUrl, host: url.hostname, port, pid: entry.pid };
    }
  }
  return null;
}

/** Reads the parent and the process group from /proc/<pid>/stat; the command name may hold spaces and parentheses. */
export function parseProcStat(pid: number, stat: string): ProcessEntry | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  // Fields after the parenthesised command name: state, ppid, pgrp, ...
  const fields = stat.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  const pgrp = Number(fields[2]);
  return Number.isSafeInteger(ppid) && Number.isSafeInteger(pgrp) && fields.length > 2 ? { pid, ppid, pgrp } : null;
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
    const inode = fields[9];
    if (local === undefined || state !== "0A" || inode === undefined) continue;
    const [address, portHex] = local.split(":");
    if (address === undefined || portHex === undefined) continue;
    sockets.push({ host: decodeAddress(address, ipv6), port: Number.parseInt(portHex, 16), inode: Number(inode) });
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

/** The real /proc. The driver runs as root in the kit, so it can read every process's fds. */
export const realProc: ProcView = {
  async listeningSockets() {
    const v4 = await readFile("/proc/net/tcp", "utf8");
    const v6 = await readFile("/proc/net/tcp6", "utf8").catch(goneOr(""));
    return [...parseProcNetTcp(v4, false), ...parseProcNetTcp(v6, true)];
  },
  async processes() {
    const entries: ProcessEntry[] = [];
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const stat = await readFile(join("/proc", name, "stat"), "utf8").catch(goneOr(null));
      const entry = stat === null ? null : parseProcStat(Number(name), stat);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  },
  async socketInodes(pid) {
    const dir = join("/proc", String(pid), "fd");
    const entries = await readdir(dir).catch(goneOr<string[]>([]));
    const inodes: number[] = [];
    for (const entry of entries) {
      const target = await readlink(join(dir, entry)).catch(goneOr(""));
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match?.[1] !== undefined) inodes.push(Number(match[1]));
    }
    return inodes;
  },
};
