// The candidate pipeline: list the sites a class rule matches, plant each in a scratch copy,
// screen each within a per-screen budget and a total spend cap, rank the survivors, and return
// a run record. Screens run one at a time, so the spend cap is checked before every screen.
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { candidateId, copyName, PlantError, plantCopy, plantedText, sha256Hex } from "./plant.ts";
import type { ClassRule, FindSites, Screen, ScreenBudget, ScreenResult, Site, Symptom } from "./types.ts";

export const RECORD_KIND = "candidate_run";
export const RECORD_VERSION = 1;

export interface Caps {
  /** Most candidates planted (and screened); sites that fail to plant do not count. */
  maxCandidates: number;
  /** Most the whole run may spend on screens, in micro-USD. */
  maxScreenSpendMicrousd: number;
  /** What each screen is given. */
  screenBudget: ScreenBudget;
}

export interface PipelineInput {
  rule: ClassRule;
  hostDir: string;
  symptom: Symptom;
  findSites: FindSites;
  screen: Screen;
  caps: Caps;
  /** Lists, checks and plants in memory only: no scratch copy, no screen, no spend. */
  dryRun: boolean;
  /** Existing directory under which the run makes its own scratch directory. */
  scratchBase: string;
  /** Keeps the planted copies after screening instead of removing them. */
  keepScratch?: boolean;
  /** The host commit the tree is at, when known; recorded as given. */
  hostCommit?: string | null;
  runId: string;
  now: () => Date;
  /** Names recorded for the finder and screen implementations. */
  implementations: { findSites: string; screen: string };
}

export type CandidateStatus =
  | "invalid_site"
  | "plant_failed"
  | "over_candidate_cap"
  | "would_screen"
  | "screened"
  | "screen_error"
  | "skipped_spend_cap"
  | "skipped_after_overspend";

export interface ScreenRecord {
  verdict: ScreenResult["verdict"];
  hits: number;
  attempts: number;
  cost_microusd: number;
}

export interface CandidateRecord {
  candidate_id: string;
  file: string;
  line: number;
  /** The finder's confidence in parts per million; canonical JSON holds integers only. */
  confidence_ppm: number;
  diff: string;
  status: CandidateStatus;
  reason: string | null;
  screen: ScreenRecord | null;
  /** What the run charged against the spend cap for this candidate, in micro-USD. */
  charged_microusd: number;
  rank: number | null;
}

export type StopReason = "spend_cap" | "screen_overspent" | null;

export interface RunRecord {
  record: typeof RECORD_KIND;
  version: typeof RECORD_VERSION;
  run_id: string;
  created_at: string;
  dry_run: boolean;
  rule: { id: string; sha256: string };
  host_commit: string | null;
  symptom_sha256: string;
  implementations: { find_sites: string; screen: string };
  caps: {
    max_candidates: number;
    max_screen_spend_microusd: number;
    screen_budget: { max_attempts: number; max_cost_microusd: number };
  };
  candidates: CandidateRecord[];
  /** Survivor candidate IDs, best first. */
  ranking: string[];
  stop_reason: StopReason;
  totals: {
    sites_found: number;
    duplicates: number;
    planted: number;
    screened: number;
    survivors: number;
    located: number;
    inconclusive: number;
    spend_microusd: number;
    /** Dry run: the most the screens would spend under the caps. Otherwise what was charged. */
    max_spend_microusd: number;
  };
}

export interface PipelineOutcome {
  record: RunRecord;
  /** The run's scratch directory, or null for a dry run or when it was removed. */
  scratchDir: string | null;
}

export class PipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineError";
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function checkCaps(caps: Caps): void {
  if (!Number.isSafeInteger(caps.maxCandidates) || caps.maxCandidates < 1) {
    throw new PipelineError("the candidate cap must be a positive integer");
  }
  if (!isNonNegativeInteger(caps.maxScreenSpendMicrousd)) {
    throw new PipelineError("the screen spend cap must be a non-negative integer of micro-USD");
  }
  if (!Number.isSafeInteger(caps.screenBudget.maxAttempts) || caps.screenBudget.maxAttempts < 1) {
    throw new PipelineError("the per-screen attempt limit must be a positive integer");
  }
  if (!isNonNegativeInteger(caps.screenBudget.maxCostMicrousd) || caps.screenBudget.maxCostMicrousd < 1) {
    throw new PipelineError("the per-screen budget must be a positive integer of micro-USD");
  }
}

/** Returns why a screen result is malformed, or null when it is well formed. */
export function screenResultProblem(result: unknown, budget: ScreenBudget): string | null {
  if (typeof result !== "object" || result === null) {
    return "screen returned no result object";
  }
  const { verdict, hits, attempts, costMicrousd } = result as Record<string, unknown>;
  if (verdict !== "located" && verdict !== "not_located" && verdict !== "inconclusive") {
    return "screen returned an unknown verdict";
  }
  if (!isNonNegativeInteger(hits) || !isNonNegativeInteger(attempts) || !isNonNegativeInteger(costMicrousd)) {
    return "screen returned hits, attempts or cost that are not non-negative integers";
  }
  if (hits > attempts) {
    return "screen returned more hits than attempts";
  }
  if (attempts > budget.maxAttempts) {
    return "screen made more attempts than its budget allows";
  }
  if (verdict === "located" && hits === 0) {
    return "screen returned located with no hits";
  }
  if (verdict === "not_located" && (hits !== 0 || attempts === 0)) {
    return "screen returned not_located with hits or with no attempts";
  }
  return null;
}

function compareSites(a: Site, b: Site): number {
  return b.confidence - a.confidence || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line;
}

/**
 * Survivors first by attempts (more independent misses is stronger evidence that the bug is
 * not findable from the source), then by finder confidence, then by file, line and ID.
 */
function compareSurvivors(a: CandidateRecord, b: CandidateRecord): number {
  const attempts = (b.screen?.attempts ?? 0) - (a.screen?.attempts ?? 0);
  if (attempts !== 0) return attempts;
  if (a.confidence_ppm !== b.confidence_ppm) return b.confidence_ppm - a.confidence_ppm;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  return a.candidate_id < b.candidate_id ? -1 : a.candidate_id > b.candidate_id ? 1 : 0;
}

function shortMessage(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : "non-error value thrown";
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function candidate(site: Site, status: CandidateStatus, reason: string | null = null): CandidateRecord {
  return {
    candidate_id: candidateId(site),
    file: site.file,
    line: Number.isSafeInteger(site.line) ? site.line : 0,
    confidence_ppm: Number.isFinite(site.confidence) ? Math.round(site.confidence * 1_000_000) : 0,
    diff: site.diff,
    status,
    reason,
    screen: null,
    charged_microusd: 0,
    rank: null,
  };
}

function isSiteShaped(value: unknown): value is Site {
  if (typeof value !== "object" || value === null) return false;
  const site = value as Record<string, unknown>;
  return typeof site.file === "string" && typeof site.diff === "string" && typeof site.line === "number" && typeof site.confidence === "number";
}

export async function runPipeline(input: PipelineInput): Promise<PipelineOutcome> {
  const { caps } = input;
  checkCaps(caps);
  let found: unknown;
  try {
    found = await input.findSites(input.rule, input.hostDir);
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    throw new PipelineError(`the site finder failed: ${shortMessage(error)}`);
  }
  if (!Array.isArray(found)) {
    throw new PipelineError("the site finder did not return an array");
  }
  const sites = (found as unknown[]).filter(isSiteShaped);
  if (sites.length !== found.length) {
    throw new PipelineError("the site finder returned an entry without file, line, diff and confidence");
  }

  const seen = new Set<string>();
  const unique: Site[] = [];
  for (const site of sites) {
    const id = candidateId(site);
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(site);
    }
  }
  unique.sort(compareSites);

  // Check and plant in memory; the first maxCandidates sites that plant become candidates.
  const records: CandidateRecord[] = [];
  const planted: { site: Site; record: CandidateRecord }[] = [];
  for (const site of unique) {
    if (planted.length >= caps.maxCandidates) {
      records.push(candidate(site, "over_candidate_cap"));
      continue;
    }
    try {
      plantedText(input.hostDir, site);
    } catch (error) {
      if (!(error instanceof PlantError)) throw error;
      const invalid = ["bad_path", "bad_line", "bad_confidence"].includes(error.reason);
      records.push(candidate(site, invalid ? "invalid_site" : "plant_failed", error.reason));
      continue;
    }
    const record = candidate(site, input.dryRun ? "would_screen" : "screened");
    records.push(record);
    planted.push({ site, record });
  }

  let spent = 0;
  let stopReason: StopReason = null;
  let scratchDir: string | null = null;
  if (!input.dryRun && planted.length > 0) {
    scratchDir = mkdtempSync(join(input.scratchBase, "rbw-candidates-"));
    for (const [index, { site, record }] of planted.entries()) {
      if (stopReason !== null) {
        record.status = stopReason === "spend_cap" ? "skipped_spend_cap" : "skipped_after_overspend";
        continue;
      }
      if (caps.maxScreenSpendMicrousd - spent < caps.screenBudget.maxCostMicrousd) {
        stopReason = "spend_cap";
        record.status = "skipped_spend_cap";
        continue;
      }
      const copy = join(scratchDir, copyName(index, record.candidate_id));
      const budget: ScreenBudget = { ...caps.screenBudget };
      try {
        plantCopy(input.hostDir, site, copy);
      } catch (error) {
        record.status = "plant_failed";
        record.reason = error instanceof PlantError ? error.reason : shortMessage(error);
        rmSync(copy, { recursive: true, force: true });
        continue;
      }
      try {
        const result: unknown = await input.screen(copy, input.symptom, budget);
        const problem = screenResultProblem(result, budget);
        if (problem !== null) {
          // The cost of a malformed result is unknown, so the whole budget is charged.
          record.status = "screen_error";
          record.reason = problem;
          record.charged_microusd = budget.maxCostMicrousd;
        } else {
          const ok = result as ScreenResult;
          record.screen = { verdict: ok.verdict, hits: ok.hits, attempts: ok.attempts, cost_microusd: ok.costMicrousd };
          record.charged_microusd = ok.costMicrousd;
          if (ok.costMicrousd > budget.maxCostMicrousd) {
            record.reason = "screen spent more than its budget";
            stopReason = "screen_overspent";
          }
        }
      } catch (error) {
        record.status = "screen_error";
        record.reason = shortMessage(error);
        record.charged_microusd = budget.maxCostMicrousd;
      } finally {
        if (input.keepScratch !== true) {
          rmSync(copy, { recursive: true, force: true });
        }
      }
      spent += record.charged_microusd;
    }
    if (input.keepScratch !== true) {
      rmdirSync(scratchDir);
      scratchDir = null;
    }
  }

  const survivors = records.filter((record) => record.status === "screened" && record.screen?.verdict === "not_located");
  survivors.sort(compareSurvivors);
  survivors.forEach((record, index) => {
    record.rank = index + 1;
  });
  const screened = records.filter((record) => record.screen !== null);
  const projected = input.dryRun
    ? Math.min(
        planted.length * caps.screenBudget.maxCostMicrousd,
        Math.floor(caps.maxScreenSpendMicrousd / caps.screenBudget.maxCostMicrousd) * caps.screenBudget.maxCostMicrousd,
      )
    : spent;

  const record: RunRecord = {
    record: RECORD_KIND,
    version: RECORD_VERSION,
    run_id: input.runId,
    created_at: input.now().toISOString(),
    dry_run: input.dryRun,
    rule: { id: input.rule.id, sha256: sha256Hex(input.rule.text) },
    host_commit: input.hostCommit ?? null,
    symptom_sha256: sha256Hex(input.symptom.text),
    implementations: { find_sites: input.implementations.findSites, screen: input.implementations.screen },
    caps: {
      max_candidates: caps.maxCandidates,
      max_screen_spend_microusd: caps.maxScreenSpendMicrousd,
      screen_budget: { max_attempts: caps.screenBudget.maxAttempts, max_cost_microusd: caps.screenBudget.maxCostMicrousd },
    },
    candidates: records,
    ranking: survivors.map((survivor) => survivor.candidate_id),
    stop_reason: stopReason,
    totals: {
      sites_found: sites.length,
      duplicates: sites.length - unique.length,
      planted: planted.length,
      screened: screened.length,
      survivors: survivors.length,
      located: screened.filter((entry) => entry.screen?.verdict === "located").length,
      inconclusive: screened.filter((entry) => entry.screen?.verdict === "inconclusive").length,
      spend_microusd: spent,
      max_spend_microusd: projected,
    },
  };
  return { record, scratchDir };
}
