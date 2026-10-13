import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatchChecked, loadAlternativeFix } from "@rbw/local-runner";
import { sha256Hex } from "@rbw/schema";
import { ALTERNATIVE_RECORD, GRADED_TRIAL, decide, gradeArgs, gradeAttempt, jobName, prepareGrade, readGrade } from "../src/grade.ts";
import type { GradeCommand, GradeNumber, GradeResult, GradeRoute, GradeTarget } from "../src/grade.ts";

// Synthetic target file: the clean file passes a time zone, the planted one drops it.
const TARGET = "src/synthetic/getStats.ts";
const CLEAN = ["export function stats(unit, zone) {", "  const start = 0;", "  const end = 1;", "  return range(unit, zone);", "}", ""].join("\n");
const PLANTED = CLEAN.replace("range(unit, zone)", "range(unit)");
const ALTERNATIVE = CLEAN.replace("range(unit, zone)", "range(unit, zone || 'UTC')");

function target(): GradeTarget {
  return { target_path: TARGET, clean_sha256: sha256Hex(Buffer.from(CLEAN)), planted: Buffer.from(PLANTED) };
}

function temp(): string {
  return mkdtempSync(join(tmpdir(), "rbw-solver-grade-"));
}

function command(work: string): GradeCommand {
  return { work, base: ["--image", "rbw-umami-kit:synthetic", "--manifest", "m.json", "--terms", "t.json", "--kit-stage", "stage"], sandboxImage: `synthetic/kit@sha256:${"ab".repeat(32)}` };
}

interface SummaryOptions {
  status?: string;
  slot?: string;
  backend?: string;
  trials?: string[];
  placed?: string | null;
  trial?: Record<string, unknown> | null;
  refusal?: string | null;
}

/** A controller summary as the controller writes it, for one grade of one attempt. */
function summary(grade: GradeNumber, route: GradeRoute, options: SummaryOptions = {}): Record<string, unknown> {
  const trial = options.trial === null ? [] : [{ trial_id: GRADED_TRIAL, code_state: "fixed", status: "complete", stage: "verify", reason: null, code: null, added_verdict: "match", original_executed: 12, original_failed: 0, failed_test_ids: [], ...options.trial }];
  return {
    schema_version: 1,
    status: options.status ?? "complete",
    reason: null,
    job: { name: jobName(grade), kind: "judge_verify", trials: options.trials ?? [GRADED_TRIAL] },
    controller: { backend: options.backend ?? (grade === 1 ? "docker" : "sandbox"), pool_key: options.slot ?? "development", allocation_key: null, slot_key: options.slot ?? "development" },
    copies: [{ trial_id: GRADED_TRIAL, copy: { placed_sha256: options.placed === undefined ? route.attempt_sha256 : options.placed } }],
    import: { refusal: options.refusal ?? null, trials: trial },
  };
}

function writeSummary(work: string, grade: GradeNumber, value: unknown): void {
  const dir = join(work, "jobs", jobName(grade));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), typeof value === "string" ? value : JSON.stringify(value));
}

function result(grade: GradeNumber, state: GradeResult["state"]): GradeResult {
  return { grade, job: jobName(grade), state, detail: null, summary_sha256: null, trial: null };
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
    expect(args).not.toContain("--fix");
    expect(gradeArgs(route, 2, { ...command("work"), referenceFix: "case/alternative" })).toEqual(expect.arrayContaining(["--fix", "case/alternative"]));
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
    expect([option(first, "--name"), option(second, "--name")]).toEqual(["grade-1-docker", "grade-2-sandbox"]);
  });

  it("refuses base options that would override the ledger, the trials, the backend or the fix", () => {
    for (const flag of ["--ledger", "--ledger=judge", "--trials", "--fix", "--judge-fixed", "--backend", "--prebuilt"]) {
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
    expect(readGrade(work, 2, route)).toMatchObject({ state: "passed", detail: null, trial: { status: "complete", added_verdict: "match", placed_sha256: route.attempt_sha256 } });
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
      ["a job that did not complete", summary(2, route, { status: "needs_reconciliation" }), "failed"],
      ["a refused job", summary(2, route, { status: "refused", placed: null, trial: null }), "failed"],
    ];
    for (const [name, value, state] of cases) {
      const work = temp();
      writeSummary(work, 2, value);
      expect({ name, state: readGrade(work, 2, route).state }).toEqual({ name, state });
    }
    expect(readGrade(temp(), 2, route)).toMatchObject({ state: "missing" });
  });

  it("counts an attempt solved only on a passed grade 2, and records any disagreement", () => {
    const t = target();
    expect(decide(t, route, [result(1, "passed"), result(2, "passed")])).toMatchObject({ solved: true, disagreement: false });
    expect(decide(t, route, [result(1, "passed"), result(2, "missing")])).toMatchObject({ solved: false, disagreement: true });
    expect(decide(t, route, [result(1, "passed"), result(2, "invalid")])).toMatchObject({ solved: false, disagreement: true });
    expect(decide(t, route, [result(1, "failed"), result(2, "passed")])).toMatchObject({ solved: true, disagreement: true });
    expect(decide(t, route, [result(1, "passed")])).toMatchObject({ solved: false, disagreement: false });
  });

  it("does not trust the controller's exit code: a zero exit with no summary is unsolved", async () => {
    const work = temp();
    const graded = await gradeAttempt(attempt, target(), command(work), { runController: () => Promise.resolve(0) });
    expect(graded).toMatchObject({ route: "alternative_fix", solved: false });
    expect(graded.grades.map((item) => item.state)).toEqual(["missing", "missing"]);
  });
});
