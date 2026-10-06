import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COPY_OUTER_LIMIT_MS, COPY_SCRIPT, KILL_GRACE_MS } from "../../src/copy.ts";
import type { AuditResult, CopyPlan } from "../../src/copy.ts";
import { ARTIFACT_LIMIT_BYTES } from "../../src/records.ts";
import { COLLECT_ARCHIVE, COLLECT_LIMIT_BYTES, PACK_SCRIPT, SANDBOX_CALL_LIMITS, STATUS_CHECKS, STATUS_INTERVAL_MS, runSandboxCopy } from "../../src/sandbox.ts";
import { FakeClock } from "../support/fakes.ts";
import { FakeSandboxSdk } from "../support/fake-sandbox.ts";
import type { FakeSandboxOptions } from "../support/fake-sandbox.ts";
import { PLANTED, TARGET, sha256, tempDir } from "../support/synthetic.ts";

const VCR_IMAGE = `synthetic-team/synthetic-project/rbw-umami-kit@sha256:${"cd".repeat(32)}`;
const PASS: AuditResult = { verdict: "pass", reason: null, report_sha256: "0".repeat(64), findings: 0 };
const NAME = "rbw-synthetic-admission-planted-02";
const ATTEMPT = "00000000-0000-4000-8000-00000000a001";

function plan(overrides: Partial<CopyPlan> = {}): CopyPlan {
  const work = tempDir();
  const jobDir = join(work, "job");
  mkdirSync(join(jobDir, "expected"), { recursive: true });
  writeFileSync(join(jobDir, "request.json"), '{"synthetic":"request"}');
  writeFileSync(join(jobDir, "expected", "trials.json"), '{"synthetic":"expected"}');
  return {
    job: "admission",
    trial_id: "planted-02",
    state: "planted",
    container: NAME,
    image: `sha256:${"ab".repeat(32)}`,
    mode: "trial",
    work_dir: join(work, "copy"),
    job_dir: jobDir,
    placement: { path: TARGET, bytes: Buffer.from(PLANTED), sha256: sha256(PLANTED) },
    audit: () => Promise.resolve(PASS),
    ...overrides,
  };
}

async function run(options: FakeSandboxOptions = {}, overrides: Partial<CopyPlan> = {}, clock = new FakeClock()) {
  const p = plan(overrides);
  const sdk = new FakeSandboxSdk(options);
  const result = await runSandboxCopy(p, { sdk, clock, image: VCR_IMAGE, attempt: ATTEMPT });
  return { p, sdk, result, clock };
}

function withinLimits(calls: { mutating: number; artifact_reads: number; stops: number }): void {
  expect(calls.mutating).toBeLessThanOrEqual(8);
  expect(calls.artifact_reads).toBeLessThanOrEqual(12);
  expect(calls.stops).toBeLessThanOrEqual(1);
}

describe("sandbox copy: create", () => {
  it("creates one sandbox from the VCR image with no persistence, no network, 4 vCPU and the outer limit as its timeout", async () => {
    const { sdk } = await run();
    const creates = sdk.calls.filter((call) => call.op === "create");
    expect(creates).toEqual([
      { op: "create", params: { image: VCR_IMAGE, name: NAME, persistent: false, networkPolicy: "deny-all", resources: { vcpus: 4 }, timeout: 720_000, tags: { attempt: ATTEMPT } } },
    ]);
    expect(COPY_OUTER_LIMIT_MS).toBe(720_000);
  });

  it("recovers a lost create response by name, and never makes a second sandbox", async () => {
    const { sdk, result } = await run({ create: "lost", collected: {} });
    expect(sdk.ops().slice(0, 3)).toEqual(["create", "get", "writeFiles"]);
    expect(sdk.calls.filter((call) => call.op === "create")).toHaveLength(1);
    expect(sdk.sandboxes.size).toBe(1);
    expect(result.sandbox.recovered_by_name).toBe(true);
    expect(result.status).toBe("complete");
    expect(result.sandbox.calls.mutating).toBe(4);
  });

  it("runs the copy command without sudo, and records the provider's error code when the command is refused", async () => {
    const { sdk, result } = await run({ copyThrows: "Status code 400 is not ok: [invalid_argument] executable file not found in $PATH: sudo" });
    const command = sdk.calls.find((call) => call.op === "runCommand");
    expect(command).toBeDefined();
    expect(JSON.stringify(command)).not.toContain("sudo");
    expect(result).toMatchObject({ status: "failed", reason: "sandbox_run_failed", records_dir: null });
    expect(result.sandbox.error_code).toBe("invalid_argument");
    expect(result.sandbox.stop_confirmed).toBe(true);
  });

  it("fails the copy when the create is refused and no sandbox holds the name, and stops nothing", async () => {
    const { sdk, result } = await run({ create: "refused" });
    expect(sdk.ops()).toEqual(["create", "get"]);
    expect(result).toMatchObject({ status: "failed", reason: "sandbox_create_failed", records_dir: null });
    expect(result.sandbox.calls.stops).toBe(0);
  });

  it("refuses a running sandbox that an earlier attempt left under the name, and leaves it running", async () => {
    const p = plan();
    const sdk = new FakeSandboxSdk();
    sdk.seed(NAME, "running", { attempt: "00000000-0000-4000-8000-00000000a000" });
    const result = await runSandboxCopy(p, { sdk, clock: new FakeClock(), image: VCR_IMAGE, attempt: ATTEMPT });
    expect(sdk.ops()).toEqual(["create", "get"]);
    expect(result).toMatchObject({ status: "failed", reason: "sandbox_name_in_use" });
    expect(result.sandbox.recovered_by_name).toBe(false);
  });

  it("refuses a name already held by a stopped sandbox from another attempt, and leaves that sandbox alone", async () => {
    const p = plan();
    const sdk = new FakeSandboxSdk();
    sdk.seed(NAME, "stopped");
    const result = await runSandboxCopy(p, { sdk, clock: new FakeClock(), image: VCR_IMAGE, attempt: ATTEMPT });
    expect(sdk.ops()).toEqual(["create", "get"]);
    expect(result).toMatchObject({ status: "failed", reason: "sandbox_name_in_use" });
  });

  it("stops a sandbox that reports a different image digest and runs nothing in it", async () => {
    const { sdk, result } = await run({ reportedImage: () => `synthetic-team/synthetic-project/rbw-umami-kit@sha256:${"ef".repeat(32)}` });
    expect(sdk.ops()).toEqual(["create", "stop", "get"]);
    expect(result).toMatchObject({ status: "failed", reason: "sandbox_image_mismatch" });
  });

  it("refuses an image reference that is not pinned by digest, before any SDK call", async () => {
    const p = plan();
    const sdk = new FakeSandboxSdk();
    const result = await runSandboxCopy(p, { sdk, clock: new FakeClock(), image: "synthetic-team/synthetic-project/rbw-umami-kit:latest", attempt: ATTEMPT });
    expect(sdk.calls).toEqual([]);
    expect(result).toMatchObject({ status: "refused", reason: "sandbox_image_not_pinned" });
  });
});

describe("sandbox copy: placement and commands", () => {
  it("places the verified file and the job directory as data in one write, and keeps the placed file", async () => {
    const { p, sdk } = await run();
    const writes = sdk.calls.filter((call) => call.op === "writeFiles");
    expect(writes).toHaveLength(1);
    const files = writes[0]?.op === "writeFiles" ? writes[0].files : [];
    expect(files.map((file) => [file.path, Buffer.from(file.content).toString("utf8"), file.mode])).toEqual([
      [`/workspace/app/${TARGET}`, PLANTED, 0o644],
      ["/var/lib/rbw/job/expected/trials.json", '{"synthetic":"expected"}', 0o644],
      ["/var/lib/rbw/job/request.json", '{"synthetic":"request"}', 0o644],
    ]);
    expect(readFileSync(join(p.work_dir, "placed", "getPageviewStats.ts"), "utf8")).toBe(PLANTED);
  });

  it("writes no app file for a clean copy, and only the job for a freeze copy", async () => {
    const clean = await run({}, { placement: null, state: "clean" });
    const cleanFiles = clean.sdk.calls.find((call) => call.op === "writeFiles");
    expect(cleanFiles?.op === "writeFiles" ? cleanFiles.files.map((file) => file.path) : []).toEqual(["/var/lib/rbw/job/expected/trials.json", "/var/lib/rbw/job/request.json"]);
    const freeze = await run({ collected: { extra: [{ name: "./original-suite.json", content: "{}" }] } }, { placement: null, state: "clean", mode: "freeze", job_dir: null });
    expect(freeze.sdk.ops()).toEqual(["create", "runCommand", "runCommand", "readFile", "stop", "get"]);
    expect(freeze.result.status).toBe("complete");
  });

  it("runs the copy script as root under tini as a subreaper, then packs and reads the record set, then stops", async () => {
    const { sdk } = await run();
    expect(sdk.ops()).toEqual(["create", "writeFiles", "runCommand", "runCommand", "readFile", "stop", "get"]);
    const commands = sdk.calls.flatMap((call) => (call.op === "runCommand" ? [call.params] : []));
    expect(commands[0]).toEqual({
      cmd: "/sbin/tini",
      args: ["-s", "--", "/bin/sh", "-c", COPY_SCRIPT, "rbw-copy", "trial", "planted-02"],
      cwd: "/workspace/app",
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root" },
      detached: true,
    });
    expect(commands[1]).toEqual({ cmd: "/bin/sh", args: ["-c", PACK_SCRIPT], detached: true });
    expect(PACK_SCRIPT).toContain(String(COLLECT_LIMIT_BYTES));
    expect(sdk.calls.find((call) => call.op === "readFile")).toEqual({ op: "readFile", name: NAME, path: COLLECT_ARCHIVE });
  });
});

describe("sandbox copy: driver exit codes", () => {
  it("imports the records of a driver that exited 0", async () => {
    const { result } = await run({ collected: { runExit: 0 } });
    expect(result).toMatchObject({ status: "complete", reason: null, freeze_exit: 0, driver_exit: 0, container_exit: 0, timed_out: false });
    expect(result.records_dir).not.toBeNull();
    expect(existsSync(join(result.records_dir ?? "", "results", "planted-02", "trial-result.json"))).toBe(true);
  });

  it("imports the incomplete records of a driver that exited 3", async () => {
    const { result } = await run({ collected: { runExit: 3 } });
    expect(result).toMatchObject({ status: "incomplete", reason: "driver_internal_error", driver_exit: 3 });
    expect(result.records_dir).not.toBeNull();
  });

  it("imports nothing from a driver that refused with exit 2", async () => {
    const { result } = await run({ collected: { runExit: 2, result: false } });
    expect(result).toMatchObject({ status: "refused", reason: "driver_refused", driver_exit: 2, records_dir: null });
  });

  it("imports nothing when the freeze failed", async () => {
    const { result } = await run({ collected: { freezeExit: 1, runExit: null }, copyExit: 90 });
    expect(result).toMatchObject({ status: "failed", reason: "freeze_failed", records_dir: null, container_exit: 90 });
  });

  it("records nothing collected when the runner directory is missing", async () => {
    const { sdk, result } = await run({ collected: null, copyExit: 90 });
    expect(sdk.ops()).toEqual(["create", "writeFiles", "runCommand", "runCommand", "stop", "get"]);
    expect(result).toMatchObject({ status: "failed", reason: "nothing_collected", collected_dir: null });
  });
});

describe("sandbox copy: limits", () => {
  it("stops a copy at the outer limit, confirms the stop, records a timeout and reads nothing back", async () => {
    const clock = new FakeClock();
    const started = clock.now();
    const { sdk, result } = await run({ copyExit: null }, {}, clock);
    expect(sdk.ops()).toEqual(["create", "writeFiles", "runCommand", "stop", "get"]);
    expect(result).toMatchObject({ status: "incomplete", reason: "timeout", timed_out: true, records_dir: null, collected_dir: null });
    expect(result.sandbox.stop_confirmed).toBe(true);
    expect(clock.sleeps[0]).toBe(COPY_OUTER_LIMIT_MS - KILL_GRACE_MS);
    expect(clock.now() - started).toBeLessThanOrEqual(COPY_OUTER_LIMIT_MS);
  });

  it("refuses a record set the pack command finds over the limit, without reading it", async () => {
    const { sdk, result } = await run({ packExit: 3 });
    expect(sdk.ops()).not.toContain("readFile");
    expect(result).toMatchObject({ status: "failed", reason: "collected_over_limit", records_dir: null, collected_dir: null });
  });

  it("stops reading an archive that grows past the limit, and imports nothing", async () => {
    const { result } = await run({ archive: Buffer.alloc(COLLECT_LIMIT_BYTES + 1) });
    expect(result).toMatchObject({ status: "failed", reason: "collected_over_limit", records_dir: null, collected_dir: null });
    expect(COLLECT_LIMIT_BYTES).toBeGreaterThan(ARTIFACT_LIMIT_BYTES);
  });

  it("refuses an archive entry that would land outside the copy directory", async () => {
    const { result } = await run({ collected: { extra: [{ name: "../escaped.txt", content: "x" }] } });
    expect(result).toMatchObject({ status: "failed", reason: "collected_unreadable", records_dir: null });
  });

  it("confirms the stop by status, polling until the sandbox reports stopped", async () => {
    const { sdk, result } = await run({ afterStop: ["stopping", "stopping", "stopped"] });
    expect(sdk.ops().slice(-4)).toEqual(["stop", "get", "get", "get"]);
    expect(result.sandbox).toMatchObject({ stop_confirmed: true, final_status: "stopped" });
  });

  it("reports an unconfirmed stop after its status checks, still within the outer limit", async () => {
    const clock = new FakeClock();
    const started = clock.now();
    const { sdk, result } = await run({ copyExit: null, afterStop: ["stopping"] }, {}, clock);
    expect(sdk.calls.filter((call) => call.op === "get")).toHaveLength(STATUS_CHECKS);
    expect(result.sandbox).toMatchObject({ stop_confirmed: false, final_status: "stopping" });
    expect(STATUS_CHECKS * STATUS_INTERVAL_MS).toBeLessThanOrEqual(KILL_GRACE_MS);
    expect(clock.now() - started).toBeLessThanOrEqual(COPY_OUTER_LIMIT_MS);
  });

  it("keeps every copy within spec §9.4's call counts and reports them", async () => {
    expect(SANDBOX_CALL_LIMITS).toEqual({ mutating: 8, artifact_reads: 12, stops: 1 });
    const scenarios: FakeSandboxOptions[] = [{}, { create: "lost" }, { copyExit: null }, { packExit: 3 }, { collected: { runExit: 3 } }, { afterStop: ["stopping"] }];
    for (const options of scenarios) {
      const { result } = await run(options);
      withinLimits(result.sandbox.calls);
      expect(result.sandbox.within_limits).toBe(true);
    }
    const { result } = await run();
    expect(result.sandbox.calls).toEqual({ mutating: 4, artifact_reads: 1, stops: 1, status_reads: 1 });
  });
});
