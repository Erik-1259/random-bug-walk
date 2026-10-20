// The candidate routes. `behavioral-qualification/v1` (the default) lists the sites a class rule
// matches and checks and plants each in memory, exactly as a dry run of the pipeline does, and records
// the planted candidates for behavioral qualification: checks on clean, buggy and reference-fixed
// copies, which run elsewhere. It makes no copy, never builds or calls a screen, reads no screen key,
// needs no database and spends nothing. `static-screen/v1` is the screening pipeline, unchanged.
import { PipelineError, runPipeline } from "./pipeline.ts";
import type { CandidateRecord, Caps } from "./pipeline.ts";
import type { ClassRule, FindSites, Screen } from "./types.ts";

export const BEHAVIORAL_ROUTE = "behavioral-qualification/v1";
export const STATIC_SCREEN_ROUTE = "static-screen/v1";
export const ROUTES = [BEHAVIORAL_ROUTE, STATIC_SCREEN_ROUTE] as const;
export type RouteName = (typeof ROUTES)[number];
export const DEFAULT_ROUTE: RouteName = BEHAVIORAL_ROUTE;

export function isRouteName(value: string): value is RouteName {
  return (ROUTES as readonly string[]).includes(value);
}

/** The default route's record: kind `candidate_run`, version 2, with its route ID. */
export const BEHAVIORAL_RECORD_VERSION = 2;

export type BehavioralCandidateStatus = "pending_qualification" | "invalid_site" | "plant_failed" | "over_candidate_cap";

export interface BehavioralCandidateRecord {
  candidate_id: string;
  file: string;
  line: number;
  /** The finder's confidence in parts per million; canonical JSON holds integers only. */
  confidence_ppm: number;
  planted_form_confirmed: boolean | null;
  confidence_level: "high" | "medium" | "low" | null;
  diff: string;
  status: BehavioralCandidateStatus;
  reason: string | null;
  /** No difficulty assessment runs on this route. */
  difficulty: { status: "not_assessed" };
}

export interface BehavioralRunRecord {
  record: "candidate_run";
  version: typeof BEHAVIORAL_RECORD_VERSION;
  route: { route_id: "behavioral-qualification"; version: "1" };
  run_id: string;
  created_at: string;
  rule: { id: string; sha256: string };
  host_commit: string | null;
  implementations: { find_sites: string };
  caps: { max_candidates: number };
  candidates: BehavioralCandidateRecord[];
  totals: { sites_found: number; duplicates: number; planted: number };
}

export interface BehavioralInput {
  rule: ClassRule;
  hostDir: string;
  findSites: FindSites;
  maxCandidates: number;
  hostCommit: string | null;
  runId: string;
  now: () => Date;
  /** The name recorded for the site finder. */
  findSitesName: string;
  /** The run's --scratch directory; the in-memory listing writes nothing there. */
  scratchBase: string;
}

/** Never called: the pipeline's dry run lists and plants in memory only. */
const NO_SCREEN: Screen = () => {
  throw new PipelineError("the behavioral-qualification route never screens");
};

function statusOf(record: CandidateRecord): BehavioralCandidateStatus {
  switch (record.status) {
    case "would_screen":
      return "pending_qualification";
    case "invalid_site":
    case "plant_failed":
    case "over_candidate_cap":
      return record.status;
    default:
      throw new PipelineError(`a dry run recorded the unexpected status ${record.status}`);
  }
}

export async function runBehavioralRoute(input: BehavioralInput): Promise<BehavioralRunRecord> {
  // The pipeline's dry run checks its caps; this route has no screen, so the screen caps are inert.
  const caps: Caps = { maxCandidates: input.maxCandidates, maxScreenSpendMicrousd: 0, screenBudget: { maxAttempts: 1, maxCostMicrousd: 1 } };
  const { record } = await runPipeline({
    rule: input.rule,
    hostDir: input.hostDir,
    symptomFor: () => ({ text: "" }),
    symptomSource: "none",
    screenModel: "super",
    findSites: input.findSites,
    screen: NO_SCREEN,
    caps,
    dryRun: true,
    scratchBase: input.scratchBase,
    hostCommit: input.hostCommit,
    runId: input.runId,
    now: input.now,
    implementations: { findSites: input.findSitesName, screen: "none" },
  });
  return {
    record: "candidate_run",
    version: BEHAVIORAL_RECORD_VERSION,
    route: { route_id: "behavioral-qualification", version: "1" },
    run_id: record.run_id,
    created_at: record.created_at,
    rule: record.rule,
    host_commit: record.host_commit,
    implementations: { find_sites: record.implementations.find_sites },
    caps: { max_candidates: record.caps.max_candidates },
    candidates: record.candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      file: candidate.file,
      line: candidate.line,
      confidence_ppm: candidate.confidence_ppm,
      planted_form_confirmed: candidate.planted_form_confirmed,
      confidence_level: candidate.confidence_level,
      diff: candidate.diff,
      status: statusOf(candidate),
      reason: candidate.reason,
      difficulty: { status: "not_assessed" },
    })),
    totals: { sites_found: record.totals.sites_found, duplicates: record.totals.duplicates, planted: record.totals.planted },
  };
}
