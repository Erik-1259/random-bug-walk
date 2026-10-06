import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COPY_OUTER_LIMIT_MS, COPY_SCRIPT, KILL_GRACE_MS, runCopies, runCopy } from "../../src/copy.ts";
import type { AuditResult, CopyPlan } from "../../src/copy.ts";
import { FakeClock, FakeDocker, deferred, failed, ok } from "../support/fakes.ts";
import type { Handler } from "../support/fakes.ts";
import { PLANTED, TARGET, sha256, tempDir } from "../support/synthetic.ts";

const IMAGE = `sha256:${"ab".repeat(32)}`;
const PASS: AuditResult = { verdict: "pass", reason: null, report_sha256: "0".repeat(64), findings: 0 };

function plan(overrides: Partial<CopyPlan> = {}): CopyPlan {
  const work = tempDir();
  const jobDir = join(work, "job");
  mkdirSync(jobDir);
  return {
    job: "admission",
    trial_id: "planted-02",
    state: "planted",
    container: "rbw-synthetic-admission-planted-02",
    image: IMAGE,
    mode: "trial",
    work_dir: join(work, "copy"),
    job_dir: jobDir,
    placement: { path: TARGET, bytes: Buffer.from(PLANTED), sha256: sha256(PLANTED) },
    audit: () => Promise.resolve(PASS),
    ...overrides,
  };
}

/** What the copy leaves in /var/lib/rbw/results/rbw-runner, written where `docker cp` would put it. */
interface Collected {
  freezeExit?: number | null;
  runExit?: number | null;
  /** A result file under out/, as the driver writes it. */
  result?: boolean;
}

function writeCollected(dest: string, trialId: string, collected: Collected): void {
  mkdirSync(join(dest, "out", "results", trialId), { recursive: true });
  if (collected.freezeExit !== null) writeFileSync(join(dest, "freeze.exit"), `${String(collected.freezeExit ?? 0)}\n`);
  if (collected.runExit !== null) writeFileSync(join(dest, "run.exit"), `${String(collected.runExit ?? 0)}\n`);
  if (collected.result !== false) writeFileSync(join(dest, "out", "results", trialId, "trial-result.json"), "{}");
}

/** A Docker that runs a copy to its end, with the given exit statuses. */
function finishing(trialId: string, collected: Collected = {}, exitCode = collected.runExit ?? 0): Handler {
  return (args) => {
    if (args[0] === "wait") return ok(`${String(exitCode)}\n`);
    if (args[0] === "cp" && String(args[1]).endsWith(":/var/lib/rbw/results/rbw-runner")) {
      writeCollected(String(args[2]), trialId, collected);
    }
    return ok();
  };
}

describe("one copy", () => {
  it("runs the exact docker commands for a planted copy, in order, with the kit's isolation and resources", async () => {
    const p = plan();
    const docker = new FakeDocker(finishing(p.trial_id));
    const result = await runCopy(p, { docker, clock: new FakeClock() });
    const placed = join(p.work_dir, "placed", "getPageviewStats.ts");
    expect(docker.calls).toEqual([
      [
        "create",
        "--name",
        "rbw-synthetic-admission-planted-02",
        "--network",
        "none",
        "--cpus",
        "4",
        "--memory",
        "8g",
        "--security-opt",
        "no-new-privileges",
        IMAGE,
        "/bin/sh",
        "-c",
        COPY_SCRIPT,
        "rbw-copy",
        "trial",
        "planted-02",
      ],
      ["cp", placed, `rbw-synthetic-admission-planted-02:/workspace/app/${TARGET}`],
      ["cp", p.job_dir ?? "", "rbw-synthetic-admission-planted-02:/var/lib/rbw/job"],
      ["start", "rbw-synthetic-admission-planted-02"],
      ["wait", "rbw-synthetic-admission-planted-02"],
      ["cp", "rbw-synthetic-admission-planted-02:/var/lib/rbw/results/rbw-runner", join(p.work_dir, "collected")],
      ["rm", "--force", "rbw-synthetic-admission-planted-02"],
    ]);
    expect(result).toMatchObject({ status: "complete", reason: null, driver_exit: 0, freeze_exit: 0, timed_out: false });
    expect(result.records_dir).toBe(join(p.work_dir, "collected", "out"));
  });

  it("places exactly the verified bytes, root-readable with mode 0644, before the container starts", async () => {
    const p = plan();
    const docker = new FakeDocker(finishing(p.trial_id));
    await runCopy(p, { docker, clock: new FakeClock() });
    const placed = join(p.work_dir, "placed", "getPageviewStats.ts");
    expect(readFileSync(placed, "utf8")).toBe(PLANTED);
    expect(statSync(placed).mode & 0o777).toBe(0o644);
    const order = docker.calls.map((call) => call[0]);
    expect(order.indexOf("start")).toBeGreaterThan(1);
  });

  it("places nothing in a clean copy, whose source is the image's own", async () => {
    const p = plan({ trial_id: "clean-01", state: "clean", placement: null, container: "rbw-synthetic-kit-check-clean-01" });
    const docker = new FakeDocker(finishing("clean-01"));
    await runCopy(p, { docker, clock: new FakeClock() });
    expect(docker.calls.filter((call) => call[0] === "cp" && String(call[2]).includes("/workspace/app"))).toEqual([]);
  });

  it("runs the freeze copy with no job and no placement", async () => {
    const p = plan({ trial_id: "freeze", state: "clean", mode: "freeze", job_dir: null, placement: null, container: "rbw-synthetic-freeze" });
    const docker = new FakeDocker((args) => {
      if (args[0] === "wait") return ok("0\n");
      if (args[0] === "cp" && String(args[1]).endsWith("rbw-runner")) {
        mkdirSync(String(args[2]), { recursive: true });
        writeFileSync(join(String(args[2]), "freeze.exit"), "0\n");
        writeFileSync(join(String(args[2]), "original-suite.json"), "{}");
      }
      return ok();
    });
    const result = await runCopy(p, { docker, clock: new FakeClock() });
    expect(docker.calls[0]?.slice(-3)).toEqual(["rbw-copy", "freeze", "freeze"]);
    expect(docker.calls.map((call) => call[0])).toEqual(["create", "start", "wait", "cp", "rm"]);
    expect(result).toMatchObject({ status: "complete", freeze_exit: 0, driver_exit: null });
  });

  it("stops a copy whose audit is refused before anything is created or built", async () => {
    const docker = new FakeDocker(finishing("planted-02"));
    const result = await runCopy(plan({ audit: () => Promise.resolve({ verdict: "refused", reason: "strict_term", report_sha256: "1".repeat(64), findings: 1 }) }), {
      docker,
      clock: new FakeClock(),
    });
    expect(docker.calls).toEqual([]);
    expect(result).toMatchObject({ status: "refused", reason: "audit_refused", records_dir: null });
    expect(result.audit.verdict).toBe("refused");
  });

  it("stops a copy whose audit is unavailable, which is never a pass", async () => {
    const docker = new FakeDocker(finishing("planted-02"));
    const result = await runCopy(plan({ audit: () => Promise.resolve({ verdict: "unavailable", reason: "terms_unavailable", report_sha256: null, findings: 0 }) }), {
      docker,
      clock: new FakeClock(),
    });
    expect(docker.calls).toEqual([]);
    expect(result).toMatchObject({ status: "refused", reason: "audit_unavailable" });
  });

  it("at the outer limit sends TERM, waits 10 s, sends KILL and records the copy incomplete with the timeout", async () => {
    const p = plan();
    const exited = deferred<ReturnType<typeof ok>>();
    const docker = new FakeDocker((args) => {
      if (args[0] === "wait") return exited.promise;
      if (args[0] === "kill" && args.includes("KILL")) exited.resolve(ok("137\n"));
      if (args[0] === "cp" && String(args[1]).endsWith("rbw-runner")) writeCollected(String(args[2]), p.trial_id, { runExit: null });
      return ok();
    });
    const clock = new FakeClock();
    const result = await runCopy(p, { docker, clock });
    const tail = docker.calls.slice(4).map((call) => call.join(" "));
    expect(tail).toEqual([
      "wait rbw-synthetic-admission-planted-02",
      "kill --signal TERM rbw-synthetic-admission-planted-02",
      "kill --signal KILL rbw-synthetic-admission-planted-02",
      `cp rbw-synthetic-admission-planted-02:/var/lib/rbw/results/rbw-runner ${join(p.work_dir, "collected")}`,
      "rm --force rbw-synthetic-admission-planted-02",
    ]);
    expect(clock.sleeps).toEqual([COPY_OUTER_LIMIT_MS, KILL_GRACE_MS]);
    expect(COPY_OUTER_LIMIT_MS).toBe(720_000);
    expect(result).toMatchObject({ status: "incomplete", reason: "timeout", timed_out: true, container_exit: 137, records_dir: null });
  });

  it("does not send KILL when TERM ends the copy within the grace period", async () => {
    const p = plan();
    const exited = deferred<ReturnType<typeof ok>>();
    const docker = new FakeDocker((args) => {
      if (args[0] === "wait") return exited.promise;
      if (args[0] === "kill") exited.resolve(ok("143\n"));
      if (args[0] === "cp" && String(args[1]).endsWith("rbw-runner")) writeCollected(String(args[2]), p.trial_id, { runExit: null });
      return ok();
    });
    const result = await runCopy(p, { docker, clock: new FakeClock() });
    expect(docker.named("kill")).toEqual([["kill", "--signal", "TERM", "rbw-synthetic-admission-planted-02"]]);
    expect(result).toMatchObject({ status: "incomplete", reason: "timeout", records_dir: null });
  });

  it("never treats a killed copy's partial files as a result, but keeps the driver's own finished result", async () => {
    const p = plan();
    const exited = deferred<ReturnType<typeof ok>>();
    const docker = new FakeDocker((args) => {
      if (args[0] === "wait") return exited.promise;
      if (args[0] === "kill" && args.includes("KILL")) exited.resolve(ok("137\n"));
      if (args[0] === "cp" && String(args[1]).endsWith("rbw-runner")) writeCollected(String(args[2]), p.trial_id, { runExit: 0 });
      return ok();
    });
    const result = await runCopy(p, { docker, clock: new FakeClock() });
    expect(result).toMatchObject({ status: "complete", timed_out: true, driver_exit: 0 });
    expect(result.records_dir).toBe(join(p.work_dir, "collected", "out"));
  });

  it("keeps the records of a driver internal error (exit 3) for import", async () => {
    const p = plan();
    const result = await runCopy(p, { docker: new FakeDocker(finishing(p.trial_id, { runExit: 3 })), clock: new FakeClock() });
    expect(result).toMatchObject({ status: "incomplete", reason: "driver_internal_error", driver_exit: 3 });
    expect(result.records_dir).toBe(join(p.work_dir, "collected", "out"));
  });

  it("records a refused input (exit 2), which writes nothing, without records", async () => {
    const p = plan();
    const result = await runCopy(p, { docker: new FakeDocker(finishing(p.trial_id, { runExit: 2, result: false })), clock: new FakeClock() });
    expect(result).toMatchObject({ status: "refused", reason: "driver_refused", driver_exit: 2, records_dir: null });
  });

  it("records a failed freeze inside the copy, before the driver's run", async () => {
    const p = plan();
    const result = await runCopy(p, { docker: new FakeDocker(finishing(p.trial_id, { freezeExit: 1, runExit: null, result: false }, 90)), clock: new FakeClock() });
    expect(result).toMatchObject({ status: "failed", reason: "freeze_failed", freeze_exit: 1, records_dir: null });
  });

  it("records a failed docker command and removes nothing it did not create", async () => {
    const docker = new FakeDocker((args) => (args[0] === "create" ? failed(125) : ok()));
    const result = await runCopy(plan(), { docker, clock: new FakeClock() });
    expect(result).toMatchObject({ status: "failed", reason: "docker_create_failed" });
    expect(docker.calls.map((call) => call[0])).toEqual(["create"]);
  });

  it("removes the container when a later command fails", async () => {
    const docker = new FakeDocker((args) => (args[0] === "start" ? failed(1) : ok()));
    const result = await runCopy(plan(), { docker, clock: new FakeClock() });
    expect(result).toMatchObject({ status: "failed", reason: "docker_start_failed" });
    expect(docker.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("times every runner phase of the copy", async () => {
    const p = plan();
    const result = await runCopy(p, { docker: new FakeDocker(finishing(p.trial_id)), clock: new FakeClock() });
    expect(result.phases.map((phase) => phase.name)).toEqual(["audit", "create", "place", "run", "collect", "remove"]);
  });
});

describe("copies run concurrently", () => {
  it("with concurrency 3, keeps at most three copies running, each with its own name and directories", async () => {
    const root = tempDir();
    const jobDir = join(root, "job");
    mkdirSync(jobDir);
    const plans = ["fixed-01", "fixed-02", "fixed-03", "fixed-04", "fixed-05"].map((trial) =>
      plan({ trial_id: trial, state: "fixed", container: `rbw-synthetic-admission-${trial}`, work_dir: join(root, "copies", "admission", trial), job_dir: jobDir }),
    );
    let active = 0;
    let peak = 0;
    const docker = new FakeDocker(async (args) => {
      if (args[0] === "start") {
        active += 1;
        peak = Math.max(peak, active);
      }
      if (args[0] === "wait") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return ok("0\n");
      }
      if (args[0] === "cp" && String(args[1]).endsWith("rbw-runner")) writeCollected(String(args[2]), String(args[1]).split("-admission-")[1]?.split(":")[0] ?? "", {});
      return ok();
    });
    const results = await runCopies(plans, 3, { docker, clock: new FakeClock() });
    expect(peak).toBe(3);
    expect(results.map((result) => result.trial_id)).toEqual(plans.map((p) => p.trial_id));
    const names = docker.named("create").map((call) => call[2]);
    expect(new Set(names).size).toBe(5);
    const workDirs = results.map((result) => result.work_dir);
    expect(new Set(workDirs).size).toBe(5);
    const written = docker.calls.filter((call) => call[0] === "cp" && String(call[1]).includes(":")).map((call) => call[2]);
    expect(new Set(written).size).toBe(5);
    expect(written.every((dest) => workDirs.filter((dir) => dest?.startsWith(`${dir}/`) === true).length === 1)).toBe(true);
    const placed = docker.calls.filter((call) => call[0] === "cp" && String(call[2]).includes(":/workspace/app/")).map((call) => call[1]);
    expect(new Set(placed).size).toBe(5);
    const shared = docker.calls.filter((call) => call[0] === "cp" && call[1] === jobDir);
    expect(shared).toHaveLength(5);
    expect(results.every((result) => result.status === "complete")).toBe(true);
  });

  it("refuses a concurrency below 1", async () => {
    await expect(runCopies([], 0, { docker: new FakeDocker(() => ok()), clock: new FakeClock() })).rejects.toThrow(/concurrency/);
  });
});
