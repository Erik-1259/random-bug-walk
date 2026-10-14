// The real screen: @rbw/screen's static-headroom probe. It asks one model, up to N times, to find
// and fix the planted bug from the shown source and the symptom alone, scores every answer in code,
// and meters every call against the spend ledger. This adapter builds the screen's input from one
// planted copy, runs it, and maps its record to the pipeline's ScreenResult.
//
// The model sees only the planted file's source and the symptom. The clean copy of the planted file
// is written to a scratch file and used only to score the answers; it is never shown to the model.
// The screen's own outputs (its record, the model's answers and the call recordings) can name source
// from a real host, so they are written to a scratch directory outside the repository and removed,
// unless the run asked to keep them or the screen left spend to reconcile.
//
// A screen that did not start, or that left an uncertain or unsettled call or a held slot, throws a
// ScreenStopError: the next screen would hit the same problem (or the held slot), and the operator
// needs the root execution and operation IDs, which the error message carries.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeScreen, loadSubject, parseScreenInput } from "@rbw/screen";
import type { ScreenOptions } from "@rbw/screen";
import type { Spend } from "@rbw/spend";
import type { FetchFunction } from "@rbw/writer";
import { PipelineError, ScreenStopError } from "./pipeline.ts";
import type { Screen, ScreenJob, ScreenResult } from "./types.ts";

/** Opens the spend ledger named by DATABASE_URL and returns it with a close function. */
export type Connect = (databaseUrl: string) => Promise<{ spend: Spend; close: () => Promise<void> }>;

export interface StaticScreenDeps {
  /** The HTTP fetch the model calls go through; tests pass a scripted fake. */
  fetch: FetchFunction;
  /** Opens the ledger; tests pass an in-memory one. */
  connect: Connect;
  /** Reads DATABASE_URL and the Token Factory key; `@rbw/screen` never prints either value. */
  env: Record<string, string | undefined>;
  /** The rate sheet bytes, hashed into every reservation. */
  rateSheet: Uint8Array;
  /** The spend slot each run acquires, and the pool each call reserves from. */
  slotKey: string;
  pool: string;
  /** `live` for a real run, `synthetic` in tests; it labels every call recording. */
  provenance: "live" | "synthetic";
  now?: () => Date;
  /** Where the screen's scratch output directory is made; default the system temporary directory. */
  outBase?: string;
  /** Keeps the screen's scratch output directory after every run (the command's --keep-scratch). */
  keepOutput?: boolean;
  /** The screen runner; injectable so tests can drive the real one with fakes or a stub. */
  execute?: typeof executeScreen;
}

/** A case name the screen input accepts (lowercase, from the planted file's path). */
function caseName(targetPath: string): string {
  return `c${createHash("sha256").update(targetPath).digest("hex").slice(0, 32)}`;
}

/** A 40-hex label for the subject's host commit, derived from the clean file so it is deterministic. */
function hostCommitLabel(cleanText: string): string {
  return createHash("sha256").update(cleanText).digest("hex").slice(0, 40);
}

/**
 * Builds a screen that runs `@rbw/screen` over one planted copy. The returned function is the
 * pipeline's Screen: it is given a planted tree, the clean copy of the planted file, the symptom and
 * the budget, and returns the verdict, hits, attempts and cost.
 */
export function makeStaticScreen(deps: StaticScreenDeps): Screen {
  const execute = deps.execute ?? executeScreen;
  const now = deps.now ?? ((): Date => new Date());

  async function staticHeadroomScreen(job: ScreenJob): Promise<ScreenResult> {
    const scratch = mkdtempSync(join(deps.outBase ?? tmpdir(), "rbw-screen-"));
    const cleanFile = join(scratch, "clean-target");
    const out = join(scratch, "out");
    let keep = deps.keepOutput === true;
    // The screen's own report lines; the last one says why it stopped or refused.
    const lines: string[] = [];
    const lastLine = (): string => lines.at(-1) ?? "the screen gave no reason";
    try {
      writeFileSync(cleanFile, job.cleanText);
      const input = parseScreenInput({
        format_version: 1,
        case: caseName(job.targetPath),
        case_status: "candidate",
        shape: "race-class-candidate",
        host: "candidate",
        host_commit: hostCommitLabel(job.cleanText),
        source_read_from: "candidate pipeline scratch copy",
        target_path: job.targetPath,
        files: [job.targetPath],
        symptom: job.symptom.text,
      });
      const subject = await loadSubject(input, job.plantedTree, cleanFile);
      const options: ScreenOptions = {
        argv: [],
        env: deps.env,
        fetch: deps.fetch,
        provenance: deps.provenance,
        connect: deps.connect,
        write: (text) => {
          lines.push(...text.split("\n").filter((line) => line !== ""));
        },
        now,
      };
      let result: Awaited<ReturnType<typeof executeScreen>>;
      try {
        result = await execute(options, {
          subject,
          model: job.model,
          attempts: job.budget.maxAttempts,
          // Any located answer fails the candidate, so the screen fails at the first hit and its
          // verdict and hit count cannot disagree about a run.
          failAtHits: 1,
          budgetMicrousd: job.budget.maxCostMicrousd,
          rateSheet: deps.rateSheet,
          out,
          slotKey: deps.slotKey,
          pool: deps.pool,
          binding: false,
        });
      } catch (error) {
        // The screen itself failed (for example the database connection dropped): what it spent
        // and whether its slot is free are unknown, so the whole budget is charged and its files kept.
        keep = true;
        const cause = error instanceof Error ? `${error.name}: ${error.message}` : "non-error value thrown";
        throw new ScreenStopError(`the screen failed (${cause}); last report: ${lastLine()}; screen output kept at ${scratch}`, job.budget.maxCostMicrousd);
      }
      const { record } = result;
      if (record === null) {
        // Nothing was started, so nothing was spent; the cause (a missing key or database, a budget
        // that cannot fit, a held slot) would stop every later screen too.
        throw new ScreenStopError(`the screen did not start: ${lastLine()}`, 0);
      }
      if (typeof record.optional_static_probe === "string") {
        throw new PipelineError("the screen did not run to a probe");
      }
      const probe = record.optional_static_probe;
      const { stopped } = probe;
      const unsettled = probe.cost.unsettled_operation_ids;
      const brokenStop = stopped !== null && (stopped.reason === "uncertain" || stopped.reason === "error" || stopped.reason === "ledger_refusal");
      const slotHeld = lines.some((line) => line.startsWith("screen: the slot stays held"));
      if (brokenStop || unsettled.length > 0 || slotHeld) {
        // Spend to reconcile by hand. A call that may have been billed is not in settled_microusd,
        // so the whole budget (the most the screen could have reserved) is charged.
        keep = true;
        const operations = [...new Set([...unsettled, ...(stopped?.operation_id == null ? [] : [stopped.operation_id])])];
        const charged = brokenStop || unsettled.length > 0 ? Math.max(job.budget.maxCostMicrousd, probe.cost.settled_microusd) : probe.cost.settled_microusd;
        throw new ScreenStopError(
          [
            `the screen left spend to reconcile (${stopped === null ? "slot not released" : `${stopped.reason}: ${stopped.detail}`})`,
            `root execution ${probe.root_execution_id}`,
            `operations ${operations.length === 0 ? "none" : operations.join(", ")}`,
            `last report: ${lastLine()}`,
            `screen output kept at ${scratch}`,
          ].join("; "),
          charged,
        );
      }
      const hits = probe.hits;
      const attempts = probe.attempts_run;
      const costMicrousd = probe.cost.settled_microusd;
      // The screen's verdict says whether the run decided anything. It is inconclusive when a call's
      // reported prompt exceeded the counted bound (that call spent outside its reserved envelope, so
      // the run decides nothing) or when the run stopped before every planned attempt gave a scored
      // answer. Such a run stays inconclusive here, whatever hits it counted before it stopped. In a
      // decided run, any located answer means the bug is findable from the source alone, so the
      // candidate fails the screen; only a pass with no hits survives.
      if (record.verdict === "inconclusive") {
        return { verdict: "inconclusive", hits: 0, attempts, costMicrousd };
      }
      if (hits > 0) {
        return { verdict: "located", hits, attempts, costMicrousd };
      }
      if (record.verdict === "pass" && attempts > 0) {
        return { verdict: "not_located", hits: 0, attempts, costMicrousd };
      }
      return { verdict: "inconclusive", hits: 0, attempts, costMicrousd };
    } finally {
      if (!keep) {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  }

  return staticHeadroomScreen;
}
