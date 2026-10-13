// The real screen: @rbw/screen's static-headroom probe. It asks one model, up to N times, to find
// and fix the planted bug from the shown source and the symptom alone, scores every answer in code,
// and meters every call against the spend ledger. This adapter builds the screen's input from one
// planted copy, runs it, and maps its record to the pipeline's ScreenResult.
//
// The model sees only the planted file's source and the symptom. The clean copy of the planted file
// is written to a scratch file and used only to score the answers; it is never shown to the model.
// The screen's own outputs (its record, the model's answers and the call recordings) can name source
// from a real host, so they are written to a scratch directory outside the repository and removed.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeScreen, loadSubject, parseScreenInput } from "@rbw/screen";
import type { ScreenOptions } from "@rbw/screen";
import type { Spend } from "@rbw/spend";
import type { FetchFunction } from "@rbw/writer";
import { PipelineError } from "./pipeline.ts";
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
  /** Hits at which a case fails the screen; default 1 (any located answer fails it). */
  failAtHits?: number;
  /** Where the screen's scratch output directory is made; default the system temporary directory. */
  outBase?: string;
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
  const failAtHits = deps.failAtHits ?? 1;
  const now = deps.now ?? ((): Date => new Date());

  async function staticHeadroomScreen(job: ScreenJob): Promise<ScreenResult> {
    const scratch = mkdtempSync(join(deps.outBase ?? tmpdir(), "rbw-screen-"));
    const cleanFile = join(scratch, "clean-target");
    const out = join(scratch, "out");
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
        write: () => undefined,
        now,
      };
      const result = await execute(options, {
        subject,
        model: job.model,
        attempts: job.budget.maxAttempts,
        failAtHits: Math.min(failAtHits, job.budget.maxAttempts),
        budgetMicrousd: job.budget.maxCostMicrousd,
        rateSheet: deps.rateSheet,
        out,
        slotKey: deps.slotKey,
        pool: deps.pool,
        binding: false,
      });
      const { record } = result;
      if (record === null || typeof record.optional_static_probe === "string") {
        // The run did not start, or did not fit the budget: the screen never decided. Throwing lets
        // the pipeline record it as a screen error and charge the whole budget, since its cost is
        // not known from a probe.
        throw new PipelineError("the screen did not run to a probe (it may have been refused or over budget)");
      }
      const probe = record.optional_static_probe;
      const hits = probe.hits;
      const attempts = probe.attempts_run;
      const costMicrousd = probe.cost.settled_microusd;
      // Any located answer means the bug is findable from the source alone, so the candidate fails
      // the screen. Only a clean pass with no hits survives; anything else is inconclusive.
      if (hits > 0) {
        return { verdict: "located", hits, attempts, costMicrousd };
      }
      if (record.verdict === "pass" && attempts > 0) {
        return { verdict: "not_located", hits: 0, attempts, costMicrousd };
      }
      return { verdict: "inconclusive", hits: 0, attempts, costMicrousd };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  return staticHeadroomScreen;
}
