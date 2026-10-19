// A deterministic fake copy runner: the copy runner convention (place the plan's files after checking
// each sha256, run, bring the results directory back) with no sandbox and no container. A copy that
// "runs" writes the planned cell to a result file in a fresh local results directory, which the fake
// adapter's `collect` reads. The results hash is the SHA-256 of that one file (synthetic; real runners
// hash a deterministic tar of the directory).
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogEntry, CollectedCopy, CopyPlan, CopyRoots, CopyRunner } from "@rbw/factory-contract";
import { FAKE_RESULT_FILE, parseSyntheticCopyId, syntheticSha } from "./catalog.ts";
import { UncertainOutcomeError } from "./harness.ts";
import type { FakeHooks } from "./harness.ts";
import type { CellPlan } from "./records.ts";
import type { ScenarioSetup } from "./scenarios.ts";

export type FakeCopyOutcome = { kind: "ran"; cell: CellPlan } | { kind: "setup_failed" } | { kind: "timed_out" } | { kind: "uncertain" };

export interface FakeRunnerOptions {
  /** What the copy of a plan does. */
  outcome(plan: CopyPlan): FakeCopyOutcome | Promise<FakeCopyOutcome>;
  now(): Date;
  /** An existing local directory; each copy's results go into a fresh directory under it. */
  resultsBase: string;
}

export interface FakeRun {
  copy_id: string;
  outcome: CollectedCopy["outcome"] | "uncertain";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The first listed file that is missing under `root` or whose content does not match its sha256. */
function mismatch(root: string, files: readonly { path: string; sha256: string }[]): string | null {
  for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(join(root, ...file.path.split("/")));
    } catch {
      return file.path;
    }
    if (sha256(bytes) !== file.sha256) return file.path;
  }
  return null;
}

export class FakeCopyRunner implements CopyRunner {
  readonly options: FakeRunnerOptions;
  readonly runs: FakeRun[] = [];

  constructor(options: FakeRunnerOptions) {
    this.options = options;
  }

  async run(plan: CopyPlan, roots: CopyRoots): Promise<CollectedCopy> {
    const startedAt = this.options.now().toISOString();
    const base = { copy_id: plan.copy_id, image_digest: plan.image.digest ?? `sha256:${syntheticSha(`image:${plan.image.reference}`)}`, architecture: "amd64" as const, started_at: startedAt };
    const unplaced = mismatch(roots.app_root, plan.files) ?? mismatch(roots.evaluator_root, plan.evaluator_files);
    const outcome: FakeCopyOutcome = unplaced === null ? await this.options.outcome(plan) : { kind: "setup_failed" };
    if (outcome.kind === "uncertain") {
      this.runs.push({ copy_id: plan.copy_id, outcome: "uncertain" });
      throw new UncertainOutcomeError();
    }
    this.runs.push({ copy_id: plan.copy_id, outcome: outcome.kind });
    if (outcome.kind !== "ran") {
      return { ...base, outcome: outcome.kind, exit_code: null, results_dir: null, finished_at: this.options.now().toISOString(), results_sha256: null };
    }
    const dir = mkdtempSync(join(this.options.resultsBase, "rbw-fake-results-"));
    const bytes = new TextEncoder().encode(`${JSON.stringify({ schema: "synthetic-copy-result/1", copy_id: plan.copy_id, state: plan.state, cell: outcome.cell })}\n`);
    writeFileSync(join(dir, FAKE_RESULT_FILE), bytes);
    return {
      ...base,
      outcome: "ran",
      exit_code: outcome.cell.verification === "fail" || outcome.cell.original_suite === "fail" ? 1 : 0,
      results_dir: dir,
      finished_at: this.options.now().toISOString(),
      results_sha256: sha256(bytes),
    };
  }
}

/**
 * A fake runner for a named scenario: each copy runs the planned cell of its entry and state, and the
 * scenario's uncertain copy, pause and lost worker apply per entry, counting copies from 1.
 */
export function scenarioCopyRunner(setup: ScenarioSetup, options: { now: () => Date; resultsBase: string; hooks?: FakeHooks }): FakeCopyRunner {
  const entries = new Map<string, CatalogEntry>(setup.registry.flatMap((adapter) => adapter.entries.map((entry) => [entry.entry_id, entry] as const)));
  const copies = new Map<string, number>();
  return new FakeCopyRunner({
    now: options.now,
    resultsBase: options.resultsBase,
    outcome: async (plan) => {
      const parsed = parseSyntheticCopyId(plan.copy_id);
      const entry = parsed === null ? undefined : entries.get(parsed.entry_id);
      if (parsed === null || entry === undefined) return { kind: "setup_failed" };
      const planned = setup.plan(entry);
      const count = (copies.get(entry.entry_id) ?? 0) + 1;
      copies.set(entry.entry_id, count);
      if (planned.uncertain_at_copy === count) return { kind: "uncertain" };
      if (planned.pause_at_copy === count) await options.hooks?.pause?.();
      if (planned.lost_after_copies !== undefined && count > planned.lost_after_copies) {
        await options.hooks?.workerLost?.();
        await options.hooks?.hang?.();
      }
      return { kind: "ran", cell: planned.states[parsed.state] };
    },
  });
}
