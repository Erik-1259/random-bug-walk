import { describe, expect, it } from "vitest";
import { listProcessEnv, parseProcNetTcp, parseProcStat, suiteEnvironmentManifest, suiteProcessEnv, verifyKitIdentity } from "../../src/environment.ts";
import type { ProcView } from "../../src/environment.ts";

const MANIFEST = suiteEnvironmentManifest({ baseUrl: "http://127.0.0.1:3000", nodeVersion: "v24.21.0" });
const PATHS = { suite_dir: "/synthetic/trial/work/suite", report_file: "/synthetic/trial/work/original-report.json" };

/**
 * /proc as seen by the driver. The driver started group 500 (rbw-start), which holds the launcher
 * 501; the launcher's child 502 leads its own group and owns the socket on 127.0.0.1:3000. Process
 * 700 leads a group whose parent 650 is outside the start group.
 */
function proc(overrides: Partial<ProcView> = {}): ProcView {
  return {
    listeningSockets: () => Promise.resolve([{ host: "127.0.0.1", port: 3000, inode: 9001 }]),
    processes: () =>
      Promise.resolve([
        { pid: 500, ppid: 1, pgrp: 500 },
        { pid: 501, ppid: 500, pgrp: 500 },
        { pid: 502, ppid: 501, pgrp: 502 },
        { pid: 650, ppid: 1, pgrp: 650 },
        { pid: 700, ppid: 650, pgrp: 700 },
      ]),
    socketInodes: (pid) => Promise.resolve(pid === 502 ? [17, 9001] : []),
    ...overrides,
  };
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
    const identity = await verifyKitIdentity({ baseUrl: "http://127.0.0.1:3000", expectedHost: "127.0.0.1", expectedPort: 3000, startGroup: 500, proc: proc() });
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
  const base = { baseUrl: "http://127.0.0.1:3000", expectedHost: "127.0.0.1", expectedPort: 3000, startGroup: 500 };

  it("accepts the expected host and port when the listener's group leader is a child of the start group", async () => {
    expect(await verifyKitIdentity({ ...base, proc: proc() })).toMatchObject({ kind: "kit", host: "127.0.0.1", port: 3000, pid: 502 });
  });

  it("refuses a base URL on another host or port", async () => {
    expect(await verifyKitIdentity({ ...base, baseUrl: "http://10.0.0.5:3000", proc: proc() })).toBeNull();
    expect(await verifyKitIdentity({ ...base, baseUrl: "http://127.0.0.1:3001", proc: proc() })).toBeNull();
  });

  it("refuses a listener whose group was not started from the start group", async () => {
    expect(await verifyKitIdentity({ ...base, startGroup: 600, proc: proc() })).toBeNull();
    const elsewhere = proc({ socketInodes: (pid) => Promise.resolve(pid === 700 ? [9001] : []) });
    expect(await verifyKitIdentity({ ...base, proc: elsewhere })).toBeNull();
  });

  it("refuses when nothing listens on the port", async () => {
    expect(await verifyKitIdentity({ ...base, proc: proc({ listeningSockets: () => Promise.resolve([]) }) })).toBeNull();
  });
});

describe("/proc readers", () => {
  it("reads listening sockets with their address, port and inode", () => {
    const text = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  2001        0 41234 1 0000000000000000 100 0 0 10 0",
      "   1: 0100007F:1538 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  2002        0 41235 1 0000000000000000 20 4 30 10 -1",
    ].join("\n");
    expect(parseProcNetTcp(text, false)).toEqual([{ host: "127.0.0.1", port: 3000, inode: 41234 }]);
  });

  it("reads the parent and the process group from a stat line whose command holds spaces and parentheses", () => {
    expect(parseProcStat(502, "502 (next-server (v1)) S 501 502 502 0 -1 4194560 0 0")).toEqual({ pid: 502, ppid: 501, pgrp: 502 });
    expect(parseProcStat(9, "")).toBeNull();
  });
});
