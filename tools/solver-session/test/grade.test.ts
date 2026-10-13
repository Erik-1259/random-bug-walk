import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatchChecked, loadAlternativeFix, newRunIds } from "@rbw/local-runner";
import { sha256Hex } from "@rbw/schema";
import { ALTERNATIVE_RECORD, GRADED_TRIAL, decide, gradeArgs, gradeAttempt, jobName, prepareGrade, readGrade, recordAttempt, runGrade, writeGradeIds } from "../src/grade.ts";
import type { GradeCommand, GradeNumber, GradeResult, GradeRoute, GradeTarget } from "../src/grade.ts";

// Synthetic target file: the clean file passes a time zone, the planted one drops it.
const TARGET = "src/synthetic/getStats.ts";
const CLEAN = ["export function stats(unit, zone) {", "  const start = 0;", "  const end = 1;", "  return range(unit, zone);", "}", ""].join("\n");
const PLANTED = CLEAN.replace("range(unit, zone)", "range(unit)");
const ALTERNATIVE = CLEAN.replace("range(unit, zone)", "range(unit, zone || 'UTC')");

function target(): GradeTarget {
  return { target_path: TARGET, clean_sha256: sha256Hex(Buffer.from(CLEAN)), planted: Buffer.from(PLANTED) };
}

const ATTEMPT = "a01";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "rbw-solver-grade-"));
}

function command(work: string): GradeCommand {
  return {
    work,
    attempt: ATTEMPT,
    base: ["--image", "rbw-umami-kit:synthetic", "--manifest", "m.json", "--terms", "t.json", "--kit-stage", "stage"],
    sandboxImage: `synthetic/kit@sha256:${"ab".repeat(32)}`,
    referenceFix: "case/alternative",
  };
}

interface SummaryOptions {
  status?: string;
  slot?: string;
  backend?: string;
  trials?: string[];
  placed?: string | null;
  trial?: Record<string, unknown> | null;
  refusal?: string | null;
  reason?: string | null;
}

/** A controller summary as the controller writes it, for one grade of one attempt. */
function summary(grade: GradeNumber, route: GradeRoute, options: SummaryOptions = {}): Record<string, unknown> {
  const trial = options.trial === null ? [] : [{ trial_id: GRADED_TRIAL, code_state: "fixed", status: "complete", stage: "verify", reason: null, code: null, added_verdict: "match", original_executed: 12, original_failed: 0, failed_test_ids: [], ...options.trial }];
  return {
    schema_version: 1,
    status: options.status ?? "complete",
    reason: options.reason ?? null,
    job: { name: jobName(grade, ATTEMPT), kind: "judge_verify", trials: options.trials ?? [GRADED_TRIAL] },
    controller: { backend: options.backend ?? (grade === 1 ? "docker" : "sandbox"), pool_key: options.slot ?? "development", allocation_key: null, slot_key: options.slot ?? "development" },
    copies: [{ trial_id: GRADED_TRIAL, copy: { placed_sha256: options.placed === undefined ? route.attempt_sha256 : options.placed } }],
    import: { refusal: options.refusal ?? null, trials: trial },
  };
}

function writeSummary(work: string, grade: GradeNumber, value: unknown): void {
  const dir = join(work, "jobs", jobName(grade, ATTEMPT));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), typeof value === "string" ? value : JSON.stringify(value));
}

function result(grade: GradeNumber, state: GradeResult["state"]): GradeResult {
  return { grade, job: jobName(grade, ATTEMPT), state, detail: null, summary_sha256: null, trial: null };
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

describe("the clean-equal route", () => {
  it("grades bytes equal to the clean file through the reference fix, with no alternative-fix files", () => {
    const dir = join(temp(), "fix");
    const route = prepareGrade(Buffer.from(CLEAN), target(), dir);
    expect(route).toEqual({ route: "clean_equal", attempt_sha256: sha256Hex(Buffer.from(CLEAN)), clean_equal: true });
    expect(existsSync(dir)).toBe(false);
    const args = gradeArgs(route, 2, command("work"));
    expect(option(args, "--judge-fixed")).toBe("fixed");
    expect(option(args, "--fix")).toBe("case/alternative");
  });

  it("refuses a clean-equal grade without the case's committed fix, before any controller run", async () => {
    const route = prepareGrade(Buffer.from(CLEAN), target(), join(temp(), "fix"));
    const rest: Partial<GradeCommand> = { ...command("work") };
    delete rest.referenceFix;
    for (const missing of [rest as GradeCommand, { ...command("work"), referenceFix: "" }]) {
      expect(() => gradeArgs(route, 1, missing)).toThrow("the case's committed alternative fix");
      let ran = 0;
      const work = temp();
      await expect(
        gradeAttempt(Buffer.from(CLEAN), target(), { ...missing, work }, {
          runController: () => {
            ran += 1;
            return Promise.resolve(0);
          },
        }),
      ).rejects.toThrow("the case's committed alternative fix");
      expect(ran).toBe(0);
    }
  });

  it("grades a clean-equal fix as solved when grade 2 places the clean bytes as fixed-01 and it passes", async () => {
    const work = temp();
    const calls: string[][] = [];
    const graded = await gradeAttempt(Buffer.from(CLEAN), target(), command(work), {
      runController: (args) => {
        calls.push([...args]);
        const grade = option(args, "--backend") === "docker" ? 1 : 2;
        writeSummary(work, grade, summary(grade, { route: "clean_equal", attempt_sha256: sha256Hex(Buffer.from(CLEAN)), clean_equal: true }));
        return Promise.resolve(0);
      },
    });
    expect(graded).toMatchObject({ route: "clean_equal", clean_equal: true, solved: true, disagreement: false, not_graded: null });
    expect(graded.grades.map((item) => item.state)).toEqual(["passed", "passed"]);
    expect(calls.map((args) => option(args, "--judge-fixed"))).toEqual(["fixed", "fixed"]);
    expect(JSON.parse(readFileSync(join(work, "grade.json"), "utf8"))).toEqual(graded);
  });
});

describe("the alternative-fix route", () => {
  it("writes alternative-fix.json and a patch the local runner loads and applies to exactly the attempt's bytes", () => {
    const dir = join(temp(), "fix");
    const route = prepareGrade(Buffer.from(ALTERNATIVE), target(), dir);
    if (route.route !== "alternative_fix") throw new Error("synthetic: expected an alternative fix");
    const loaded = loadAlternativeFix(dir);
    expect(loaded).toMatchObject({ target_path: TARGET, base_sha256: sha256Hex(Buffer.from(PLANTED)), result_sha256: sha256Hex(Buffer.from(ALTERNATIVE)), patch_sha256: route.patch_sha256 });
    expect(applyPatchChecked(Buffer.from(PLANTED), loaded.patch, { target: TARGET, base_sha256: loaded.base_sha256, result_sha256: loaded.result_sha256 }).toString("utf8")).toBe(ALTERNATIVE);
    const args = gradeArgs(route, 1, command("work"));
    expect(option(args, "--fix")).toBe(dir);
    expect(option(args, "--judge-fixed")).toBe("alternative_fix");
  });

  it("round-trips a fix that drops the final newline", () => {
    const attempt = ALTERNATIVE.trimEnd();
    const dir = join(temp(), "fix");
    const route = prepareGrade(Buffer.from(attempt), target(), dir);
    expect(route.route).toBe("alternative_fix");
    const loaded = loadAlternativeFix(dir);
    expect(applyPatchChecked(Buffer.from(PLANTED), loaded.patch, { target: TARGET, base_sha256: loaded.base_sha256, result_sha256: loaded.result_sha256 }).toString("utf8")).toBe(attempt);
  });

  it("does not grade an unchanged planted file or bytes that are not UTF-8, and counts them unsolved", async () => {
    for (const [bytes, reason] of [
      [Buffer.from(PLANTED), "unchanged"],
      [Buffer.from([0xff, 0xfe, 0x00]), "invalid_fix"],
    ] as const) {
      const work = temp();
      let ran = 0;
      const graded = await gradeAttempt(bytes, target(), command(work), {
        runController: () => {
          ran += 1;
          return Promise.resolve(0);
        },
      });
      expect(ran).toBe(0);
      expect(graded).toMatchObject({ route: "not_graded", solved: false, grades: [], not_graded: { reason } });
      expect(existsSync(join(work, "fix", ALTERNATIVE_RECORD))).toBe(false);
    }
  });
});

describe("the grade commands", () => {
  const route: GradeRoute = { route: "clean_equal", attempt_sha256: "0".repeat(64), clean_equal: true };

  it("runs judge_verify on fixed-01 alone, on the development ledger, Docker first and Sandbox second", () => {
    const first = gradeArgs(route, 1, command("w"));
    const second = gradeArgs(route, 2, command("w"));
    for (const args of [first, second]) {
      expect(args[0]).toBe("run");
      expect(option(args, "--job-kind")).toBe("judge_verify");
      expect(option(args, "--ledger")).toBe("development");
      expect(option(args, "--trials")).toBe(GRADED_TRIAL);
    }
    expect([option(first, "--backend"), option(first, "--sandbox-image")]).toEqual(["docker", undefined]);
    expect([option(second, "--backend"), option(second, "--sandbox-image")]).toEqual(["sandbox", command("w").sandboxImage]);
    expect([option(first, "--name"), option(second, "--name")]).toEqual(["grade-1-docker-a01-r0", "grade-2-sandbox-a01-r0"]);
  });

  it("names each attempt's grades apart, so attempts under one root never share a call name or operation", () => {
    const one = gradeArgs(route, 2, { ...command("w"), attempt: "a01" });
    const two = gradeArgs(route, 2, { ...command("w"), attempt: "a02" });
    expect(option(one, "--name")).not.toBe(option(two, "--name"));
    for (const bad of ["", "A01", "a_01", "a--1", "-a1"]) expect(() => gradeArgs(route, 2, { ...command("w"), attempt: bad })).toThrow("the attempt label");
  });

  it("passes each grade its own ids file and the project policy, and keeps them out of the base options", () => {
    const ids = { 1: "ids/grade-1.json", 2: "ids/grade-2.json" } as const;
    const withIds = { ...command("w"), ids, projectPolicy: "policy.json" };
    expect([option(gradeArgs(route, 1, withIds), "--ids"), option(gradeArgs(route, 2, withIds), "--ids")]).toEqual([ids[1], ids[2]]);
    expect([option(gradeArgs(route, 1, withIds), "--project-policy"), option(gradeArgs(route, 2, withIds), "--project-policy")]).toEqual(["policy.json", "policy.json"]);
    expect(gradeArgs(route, 1, command("w"))).not.toContain("--ids");
    expect(() => gradeArgs(route, 1, { ...command("w"), ids: { 1: "same.json", 2: "same.json" } })).toThrow("its own ids file");
    expect(() => gradeArgs(route, 1, { ...command("w"), projectPolicy: "policy.json" })).toThrow("needs the per-grade ids");
  });

  it("writes one ids file per grade under the attempt root, with a fresh alternative-fix execution each", () => {
    const root = newRunIds(() => "11111111-1111-4111-8111-111111111111");
    let next = 0;
    const uuid = () => `22222222-2222-4222-8222-${String(next++).padStart(12, "0")}`;
    const dir = temp();
    const files = writeGradeIds(root, dir, ATTEMPT, uuid);
    const [first, second] = [1, 2].map((grade) => JSON.parse(readFileSync(files[grade as GradeNumber], "utf8")) as typeof root);
    if (first === undefined || second === undefined) throw new Error("synthetic: two ids files");
    for (const ids of [first, second]) expect({ ...ids, executions: { ...ids.executions, "alternative-fix": "x" } }).toEqual({ ...root, executions: { ...root.executions, "alternative-fix": "x" } });
    expect(new Set([root.executions["alternative-fix"], first.executions["alternative-fix"], second.executions["alternative-fix"]]).size).toBe(3);
    expect(files[1]).not.toBe(files[2]);
  });

  it("runs one grade on its own, so the runner can run grade 2 serially after concurrent sessions", async () => {
    const work = temp();
    const route = prepareGrade(Buffer.from(ALTERNATIVE), target(), join(work, "fix"));
    const calls: string[][] = [];
    const graded = await runGrade(route, 2, command(work), {
      runController: (args) => {
        calls.push([...args]);
        writeSummary(work, 2, summary(2, route));
        return Promise.resolve(0);
      },
    });
    expect(calls.map((args) => option(args, "--backend"))).toEqual(["sandbox"]);
    expect(graded.state).toBe("passed");
    expect(recordAttempt(target(), route, [graded], work)).toMatchObject({ solved: true });
    expect(JSON.parse(readFileSync(join(work, "grade.json"), "utf8"))).toMatchObject({ solved: true, grades: [{ grade: 2, state: "passed" }] });
  });

  it("refuses base options that would override the ledger, the trials, the backend or the fix", () => {
    for (const flag of ["--ledger", "--ledger=judge", "--trials", "--fix", "--judge-fixed", "--backend", "--prebuilt", "--ids", "--project-policy=p.json"]) {
      expect(() => gradeArgs(route, 2, { ...command("w"), base: [flag, "x"] })).toThrow("the grade sets it");
    }
  });
});

describe("reading a grade", () => {
  const attempt = Buffer.from(ALTERNATIVE);
  const route: GradeRoute = { route: "alternative_fix", attempt_sha256: sha256Hex(attempt), clean_equal: false, fix_dir: "fix", patch_sha256: "0".repeat(64) };

  it("passes a complete fixed-01 with added verdict match and no original-suite failure", () => {
    const work = temp();
    writeSummary(work, 2, summary(2, route));
    expect(readGrade(work, 2, route, ATTEMPT)).toMatchObject({ state: "passed", detail: null, trial: { status: "complete", added_verdict: "match", placed_sha256: route.attempt_sha256 } });
  });

  it("never passes a missing, malformed or tampered result", () => {
    const cases: [string, unknown, GradeResult["state"]][] = [
      ["malformed", "{not json", "invalid"],
      ["the judge slot", summary(2, route, { slot: "judge" }), "invalid"],
      ["the wrong backend", summary(2, route, { backend: "docker" }), "invalid"],
      ["the whole profile", summary(2, route, { trials: ["clean-01", "planted-01", GRADED_TRIAL] }), "invalid"],
      ["other bytes placed", summary(2, route, { placed: "f".repeat(64) }), "invalid"],
      ["no placement", summary(2, route, { placed: null }), "invalid"],
      ["fixed-01's result missing", summary(2, route, { trial: null }), "failed"],
      ["fixed-01's records tampered", summary(2, route, { trial: { status: "invalid", reason: "verifier_record_mismatch", added_verdict: null } }), "failed"],
      ["fixed-01 incomplete", summary(2, route, { trial: { status: "incomplete", added_verdict: null } }), "failed"],
      ["added checks rejected", summary(2, route, { trial: { added_verdict: "reject" } }), "failed"],
      ["an original-suite failure", summary(2, route, { trial: { original_failed: 1, failed_test_ids: ["t1"] } }), "failed"],
      ["no original-suite test ran", summary(2, route, { trial: { original_executed: 0 } }), "failed"],
      ["the import refused", summary(2, route, { refusal: "evidence_mismatch" }), "failed"],
      ["the import refused, as the controller ends it", summary(2, route, { status: "incomplete", refusal: "evidence_mismatch" }), "failed"],
      ["the import refused, then a blocked slot release", summary(2, route, { status: "needs_reconciliation", reason: "slot_release_blocked", refusal: "evidence_mismatch" }), "failed"],
      ["the import refused, then a ledger outage", summary(2, route, { status: "needs_reconciliation", reason: "ledger_unavailable", refusal: "evidence_mismatch", trial: null }), "failed"],
      ["a job left for reconciliation before a verdict", summary(2, route, { status: "needs_reconciliation", reason: "ledger_unavailable", trial: null }), "infrastructure"],
      ["a verdict match, then a ledger outage", summary(2, route, { status: "needs_reconciliation", reason: "ledger_unavailable" }), "passed"],
      ["a verdict reject, then a ledger outage", summary(2, route, { status: "needs_reconciliation", reason: "ledger_unavailable", trial: { added_verdict: "reject" } }), "failed"],
      ["a verdict reject, then a blocked slot release", summary(2, route, { status: "needs_reconciliation", reason: "slot_release_blocked", trial: { added_verdict: "reject" } }), "failed"],
      ["a verdict for other bytes, then a ledger outage", summary(2, route, { status: "needs_reconciliation", reason: "ledger_unavailable", placed: "f".repeat(64) }), "invalid"],
      ["an incomplete trial, then a ledger outage", summary(2, route, { status: "needs_reconciliation", reason: "ledger_unavailable", trial: { status: "incomplete", added_verdict: null } }), "infrastructure"],
      ["a refused slot", summary(2, route, { status: "refused", reason: "slot_busy", placed: null, trial: null }), "infrastructure"],
      ["a job that could not build", summary(2, route, { status: "refused", reason: "cannot_build", placed: null, trial: null }), "infrastructure"],
      ["a refused reservation", summary(2, route, { status: "incomplete", reason: "reserve_operation_conflict", placed: null, trial: null }), "infrastructure"],
      ["a copy error", summary(2, route, { status: "incomplete", reason: "copy_error", trial: null }), "infrastructure"],
    ];
    for (const [name, value, state] of cases) {
      const work = temp();
      writeSummary(work, 2, value);
      expect({ name, state: readGrade(work, 2, route, ATTEMPT).state }).toEqual({ name, state });
    }
    expect(readGrade(temp(), 2, route, ATTEMPT)).toMatchObject({ state: "missing" });
  });

  it("counts an attempt solved only on a passed grade 2, and records any disagreement", () => {
    const t = target();
    expect(decide(t, route, [result(1, "passed"), result(2, "passed")])).toMatchObject({ solved: true, disagreement: false });
    expect(decide(t, route, [result(1, "passed"), result(2, "missing")])).toMatchObject({ solved: false, disagreement: true });
    expect(decide(t, route, [result(1, "passed"), result(2, "invalid")])).toMatchObject({ solved: false, disagreement: true });
    expect(decide(t, route, [result(1, "failed"), result(2, "passed")])).toMatchObject({ solved: true, disagreement: true });
    expect(decide(t, route, [result(1, "passed")])).toMatchObject({ solved: false, disagreement: false });
  });

  it("reports an infrastructure grade apart: unsolved, rerunnable, and never a disagreement", () => {
    const t = target();
    expect(decide(t, route, [result(1, "passed"), result(2, "infrastructure")])).toMatchObject({ solved: false, infrastructure: true, disagreement: false });
    expect(decide(t, route, [result(1, "infrastructure"), result(2, "failed")])).toMatchObject({ solved: false, infrastructure: false, disagreement: false });
    expect(decide(t, route, [result(1, "passed"), result(2, "failed")])).toMatchObject({ infrastructure: false, disagreement: true });
  });

  it("gives a rerun of an infrastructure grade its own job, so the controller does not replay the refused one", async () => {
    const work = temp();
    // A controller that, like runJob, returns a job's stored summary when the named job already ran.
    const outcomes = [summary(2, route, { status: "refused", reason: "slot_busy", placed: null, trial: null })];
    const names: string[] = [];
    const runController = (args: readonly string[]) => {
      const name = option(args, "--name") ?? "";
      names.push(name);
      const file = join(work, "jobs", name, "summary.json");
      if (!existsSync(file)) {
        mkdirSync(join(work, "jobs", name), { recursive: true });
        writeFileSync(file, JSON.stringify({ ...(outcomes.shift() ?? summary(2, route)), job: { name, kind: "judge_verify", trials: [GRADED_TRIAL] } }));
      }
      return Promise.resolve(0);
    };
    const first = await runGrade(route, 2, command(work), { runController });
    expect(first.state).toBe("infrastructure");
    expect((await runGrade(route, 2, command(work), { runController })).state).toBe("infrastructure");
    const rerun = await runGrade(route, 2, { ...command(work), retry: 1 }, { runController });
    expect(rerun).toMatchObject({ state: "passed", job: jobName(2, ATTEMPT, 1) });
    expect(new Set(names).size).toBe(2);
    expect(jobName(2, ATTEMPT, 1)).not.toBe(jobName(2, `${ATTEMPT}-r1`, 0));
    for (const retry of [-1, 1.5]) expect(() => jobName(2, ATTEMPT, retry)).toThrow("retry");
  });

  it("does not trust the controller's exit code: a zero exit with no summary is unsolved", async () => {
    const work = temp();
    const graded = await gradeAttempt(attempt, target(), command(work), { runController: () => Promise.resolve(0) });
    expect(graded).toMatchObject({ route: "alternative_fix", solved: false });
    expect(graded.grades.map((item) => item.state)).toEqual(["missing", "missing"]);
  });
});
