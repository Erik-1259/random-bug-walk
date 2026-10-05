import { describe, expect, it } from "vitest";
import {
  listProcessEnv,
  parseProcNetTcp,
  parseProcStat,
  parseProcStatusUid,
  procView,
  suiteEnvironmentManifest,
  suiteProcessEnv,
  verifyKitIdentity,
} from "../../src/environment.ts";
import type { ProcFiles, ProcView } from "../../src/environment.ts";

const MANIFEST = suiteEnvironmentManifest({ baseUrl: "http://127.0.0.1:3000", nodeVersion: "v24.21.0" });
const PATHS = { suite_dir: "/synthetic/trial/work/suite", report_file: "/synthetic/trial/work/original-report.json" };
const APP_UID = 2001;

/**
 * /proc as seen by the driver. The driver started group 500 (rbw-start), which has exited and left
 * the Umami launcher 501 (named by /run/rbw/umami.pid) and the Postgres launcher 503. The Umami
 * launcher's child 502 runs as rbw-app and leads its own group, with a worker 505; 127.0.0.1:3000
 * is listening under rbw-app's UID. Postgres (504) runs as rbw-db.
 */
const PROCESSES = [
  { pid: 501, ppid: 1, pgrp: 500, uid: 0, alive: true },
  { pid: 502, ppid: 501, pgrp: 502, uid: APP_UID, alive: true },
  { pid: 503, ppid: 1, pgrp: 500, uid: 0, alive: true },
  { pid: 504, ppid: 503, pgrp: 504, uid: 2002, alive: true },
  { pid: 505, ppid: 502, pgrp: 502, uid: APP_UID, alive: true },
];

function proc(overrides: Partial<ProcView> = {}): ProcView {
  return {
    listeningSockets: () =>
      Promise.resolve([
        { host: "127.0.0.1", port: 3000, inode: 9001, uid: APP_UID },
        { host: "127.0.0.1", port: 5432, inode: 9002, uid: 2002 },
      ]),
    processes: () => Promise.resolve(PROCESSES),
    pidFile: (name) => Promise.resolve(name === "umami" ? 501 : null),
    ...overrides,
  };
}

const TCP_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

/**
 * The same processes as real /proc files, as Docker's default capabilities expose them to root:
 * stat, status and the fd directory listing are readable, but following another user's fd links
 * fails with EACCES, because root lacks CAP_SYS_PTRACE.
 */
function procFiles(): ProcFiles & { readlinkCalls: number; readlink: (path: string) => Promise<string> } {
  const byPid = new Map(PROCESSES.map((entry) => [String(entry.pid), entry]));
  const files: Record<string, string> = {
    "/proc/net/tcp": [
      TCP_HEADER,
      "   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  2001        0 9001 1 0000000000000000 100 0 0 10 0",
      "   1: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000  2002        0 9002 1 0000000000000000 100 0 0 10 0",
    ].join("\n"),
    "/proc/net/tcp6": TCP_HEADER,
    "/run/rbw/umami.pid": "501\n",
  };
  for (const entry of PROCESSES) {
    files[`/proc/${String(entry.pid)}/stat`] = `${String(entry.pid)} (node server) S ${String(entry.ppid)} ${String(entry.pgrp)} ${String(entry.pgrp)} 0 -1 4194560`;
    const uid = String(entry.uid);
    files[`/proc/${String(entry.pid)}/status`] = `Name:\tnode\nState:\tS (sleeping)\nPid:\t${String(entry.pid)}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
  }
  const fake = {
    readlinkCalls: 0,
    readFile(path: string): Promise<string> {
      const text = files[path];
      if (text !== undefined) return Promise.resolve(text);
      return Promise.reject(Object.assign(new Error("synthetic missing file"), { code: "ENOENT" }));
    },
    readdir(path: string): Promise<string[]> {
      if (path === "/proc") return Promise.resolve([...byPid.keys(), "self", "net"]);
      if (/^\/proc\/\d+\/fd$/.test(path)) return Promise.resolve(["0", "1", "2", "19"]);
      return Promise.reject(Object.assign(new Error("synthetic missing directory"), { code: "ENOENT" }));
    },
    readlink(): Promise<string> {
      fake.readlinkCalls += 1;
      return Promise.reject(Object.assign(new Error("synthetic permission denied"), { code: "EACCES" }));
    },
  };
  return fake;
}
describe("suite environment", () => {
  it("runs the suite with API_COVERAGE=report and API_SKIP_SEED absent", () => {
    const env = suiteProcessEnv(MANIFEST, PATHS, null);
    expect(env.API_COVERAGE).toBe("report");
    expect("API_SKIP_SEED" in env).toBe(false);
    expect("CI" in env).toBe(false);
    expect(env.PLAYWRIGHT_BASE_URL).toBe("http://127.0.0.1:3000");
    expect(env.PLAYWRIGHT_JSON_OUTPUT_FILE).toBe(PATHS.report_file);
    expect(MANIFEST.absent).toEqual(expect.arrayContaining(["API_SKIP_SEED", "CI"]));
  });

  it("leaves API_ALLOW_DESTRUCTIVE unset before the identity check and sets it to 1 after", async () => {
    expect("API_ALLOW_DESTRUCTIVE" in suiteProcessEnv(MANIFEST, PATHS, null)).toBe(false);
    const identity = await verifyKitIdentity({
      baseUrl: "http://127.0.0.1:3000",
      expectedHost: "127.0.0.1",
      expectedPort: 3000,
      startGroup: 500,
      appUid: APP_UID,
      launcher: "umami",
      proc: proc(),
    });
    expect(identity).not.toBeNull();
    expect(suiteProcessEnv(MANIFEST, PATHS, identity).API_ALLOW_DESTRUCTIVE).toBe("1");
  });

  it("never sets API_ALLOW_DESTRUCTIVE for the --list run that freezes the manifest", () => {
    const env = listProcessEnv(MANIFEST, PATHS);
    expect("API_ALLOW_DESTRUCTIVE" in env).toBe(false);
    expect(env.API_COVERAGE).toBe("report");
  });

  it("records placeholders, not per-trial paths, so a run's manifest equals the frozen one", () => {
    expect(MANIFEST.variables.PLAYWRIGHT_JSON_OUTPUT_FILE).toBe("{report_file}");
    expect(JSON.stringify(MANIFEST)).not.toContain("/synthetic/");
    expect(MANIFEST.after_identity_check).toEqual({ API_ALLOW_DESTRUCTIVE: "1" });
  });
});

describe("kit identity check", () => {
  const base = { baseUrl: "http://127.0.0.1:3000", expectedHost: "127.0.0.1", expectedPort: 3000, startGroup: 500, appUid: APP_UID, launcher: "umami" };
  const otherAppProcess = { pid: 700, ppid: 650, pgrp: 700, uid: APP_UID, alive: true };

  it("accepts an rbw-app listener when the launcher in /run/rbw is in the start group and its child leads the only rbw-app group", async () => {
    expect(await verifyKitIdentity({ ...base, proc: proc() })).toEqual({ kind: "kit", base_url: "http://127.0.0.1:3000", host: "127.0.0.1", port: 3000, pid: 502 });
  });

  it("works from real /proc files when following another user's fd links fails with EACCES", async () => {
    const files = procFiles();
    await expect(files.readlink("/proc/502/fd/0")).rejects.toMatchObject({ code: "EACCES" });
    files.readlinkCalls = 0;
    expect(await verifyKitIdentity({ ...base, proc: procView(files, "/run/rbw") })).toMatchObject({ kind: "kit", port: 3000, pid: 502 });
    expect(files.readlinkCalls).toBe(0);
  });

  it("refuses a base URL on another host or port", async () => {
    expect(await verifyKitIdentity({ ...base, baseUrl: "http://10.0.0.5:3000", proc: proc() })).toBeNull();
    expect(await verifyKitIdentity({ ...base, baseUrl: "http://127.0.0.1:3001", proc: proc() })).toBeNull();
  });

  it("refuses a listener owned by another UID, even next to an rbw-app listener on the same port", async () => {
    const asRoot = proc({ listeningSockets: () => Promise.resolve([{ host: "127.0.0.1", port: 3000, inode: 9001, uid: 0 }]) });
    expect(await verifyKitIdentity({ ...base, proc: asRoot })).toBeNull();
    const asDb = proc({ listeningSockets: () => Promise.resolve([{ host: "0.0.0.0", port: 3000, inode: 9003, uid: 2002 }]) });
    expect(await verifyKitIdentity({ ...base, proc: asDb })).toBeNull();
    const both = proc({
      listeningSockets: () =>
        Promise.resolve([
          { host: "127.0.0.1", port: 3000, inode: 9001, uid: APP_UID },
          { host: "::", port: 3000, inode: 9004, uid: 0 },
        ]),
    });
    expect(await verifyKitIdentity({ ...base, proc: both })).toBeNull();
  });

  it("refuses when an rbw-app process outside the launched group could hold the socket", async () => {
    const extra = proc({ processes: () => Promise.resolve([...PROCESSES, otherAppProcess]) });
    expect(await verifyKitIdentity({ ...base, proc: extra })).toBeNull();
    const zombie = proc({ processes: () => Promise.resolve([...PROCESSES, { ...otherAppProcess, alive: false }]) });
    expect(await verifyKitIdentity({ ...base, proc: zombie })).not.toBeNull();
  });

  it("refuses when the launcher was not started by this trial's rbw-start, or has ended", async () => {
    expect(await verifyKitIdentity({ ...base, startGroup: 600, proc: proc() })).toBeNull();
    expect(await verifyKitIdentity({ ...base, proc: proc({ pidFile: () => Promise.resolve(null) }) })).toBeNull();
    expect(await verifyKitIdentity({ ...base, proc: proc({ pidFile: () => Promise.resolve(503) }) })).toBeNull();
    const ended = PROCESSES.map((entry) => (entry.pid === 501 ? { ...entry, alive: false } : entry));
    expect(await verifyKitIdentity({ ...base, proc: proc({ processes: () => Promise.resolve(ended) }) })).toBeNull();
  });

  it("refuses when the launcher's child is not an rbw-app group leader", async () => {
    const notLeader = PROCESSES.map((entry) => (entry.pid === 502 ? { ...entry, pgrp: 500 } : entry.pid === 505 ? { ...entry, pgrp: 500 } : entry));
    expect(await verifyKitIdentity({ ...base, proc: proc({ processes: () => Promise.resolve(notLeader) }) })).toBeNull();
    const asRoot = PROCESSES.filter((entry) => entry.pid !== 505).map((entry) => (entry.pid === 502 ? { ...entry, uid: 0 } : entry));
    expect(await verifyKitIdentity({ ...base, proc: proc({ processes: () => Promise.resolve(asRoot) }) })).toBeNull();
  });

  it("refuses when nothing listens on the port", async () => {
    expect(await verifyKitIdentity({ ...base, proc: proc({ listeningSockets: () => Promise.resolve([]) }) })).toBeNull();
  });
});

describe("/proc readers", () => {
  it("reads listening sockets with their address, port, inode and owner UID", () => {
    const text = [
      TCP_HEADER,
      "   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  2001        0 41234 1 0000000000000000 100 0 0 10 0",
      "   1: 0100007F:1538 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  2002        0 41235 1 0000000000000000 20 4 30 10 -1",
    ].join("\n");
    expect(parseProcNetTcp(text, false)).toEqual([{ host: "127.0.0.1", port: 3000, inode: 41234, uid: 2001 }]);
  });

  it("reads the parent, the process group and whether the process is alive from a stat line whose command holds spaces and parentheses", () => {
    expect(parseProcStat(502, "502 (next-server (v1)) S 501 502 502 0 -1 4194560 0 0")).toEqual({ pid: 502, ppid: 501, pgrp: 502, alive: true });
    expect(parseProcStat(503, "503 (node) Z 501 502 502 0 -1 4194560 0 0")).toEqual({ pid: 503, ppid: 501, pgrp: 502, alive: false });
    expect(parseProcStat(9, "")).toBeNull();
  });

  it("reads the effective UID from a status file", () => {
    expect(parseProcStatusUid("Name:\tnode\nUid:\t0\t2001\t2001\t2001\nGid:\t0\t0\t0\t0\n")).toBe(2001);
    expect(parseProcStatusUid("Name:\tnode\n")).toBeNull();
  });

  it("reads the kit's PID files from /run/rbw, and reports a missing one as null", async () => {
    const view = procView(procFiles(), "/run/rbw");
    expect(await view.pidFile("umami")).toBe(501);
    expect(await view.pidFile("postgres")).toBeNull();
  });
});
