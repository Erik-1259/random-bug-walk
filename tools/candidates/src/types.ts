// The interfaces the pipeline calls. The real site finder comes from @rbw/shapes and the real
// screen from @rbw/screen; src/wiring.ts binds them, and tests pass fakes.

/** A class-level shape rule: the rule file the site finder runs over the host tree. */
export interface ClassRule {
  /** The rule's ID, for example a class ID such as "RC-1.read-await-write". */
  id: string;
  /** Path to the rule file, as given on the command line. */
  path: string;
  /** The rule file's text. The run record keeps its SHA-256, not the text. */
  text: string;
}

/** One place in the host where the class occurs, with the rewrite that plants the bug there. */
export interface Site {
  /** Host-relative path with "/" separators, for example "src/lib/thing.ts". */
  file: string;
  /** 1-based line of the matched code in the clean file. */
  line: number;
  /** A unified diff that changes only `file`, from the clean form to the planted form. */
  diff: string;
  /** The finder's confidence that this site is a real instance of the class, from 0 to 1. */
  confidence: number;
  /**
   * The bug class the finder matched here, for example `RACE.guarded-write`. The symptom template
   * reads it to pick the per-class wording. The real finder sets it; fakes may leave it undefined,
   * and the template then falls back to a generic race symptom. It is not part of the candidate ID.
   */
  classId?: string;
  /**
   * Whether the finder confirmed that the rewrite plants the bug's form (for a guarded write: no
   * other guard is left, so the write is no longer conditional). An unconfirmed site is planted and
   * ranked after every confirmed one. Undefined when the finder does not report it.
   */
  plantedFormConfirmed?: boolean;
  /** The finder's confidence level, for the record; undefined when the finder does not report one. */
  confidenceLevel?: "high" | "medium" | "low";
}

export type FindSites = (rule: ClassRule, hostDir: string) => Promise<readonly Site[]> | readonly Site[];

/** The symptom a screen is told about: the issue-style description of what goes wrong. */
export interface Symptom {
  text: string;
}

/** The screen model profile a run uses; the names @rbw/screen's profiles carry. */
export type ScreenModel = "super" | "kimi";

/** The most one screen may spend. */
export interface ScreenBudget {
  /** Most attempts (model probes) the screen may make. */
  maxAttempts: number;
  /** Most the screen may spend, in micro-USD (1 USD = 1,000,000). */
  maxCostMicrousd: number;
}

/**
 * One screen job: a planted copy of the host tree, the clean copy of the one planted file (for
 * scoring the model's answer; never shown to the model), the symptom the model is told, the budget,
 * and the model profile. The model sees only the tree's source and the symptom.
 */
export interface ScreenJob {
  /** Root of the planted copy. */
  plantedTree: string;
  /** Host-relative path of the planted file within `plantedTree`. */
  targetPath: string;
  /** The clean (unplanted) text of the planted file, used only for scoring. */
  cleanText: string;
  /** The per-candidate symptom text; the model is told only this. */
  symptom: Symptom;
  /** The spend and attempt budget for this one screen. */
  budget: ScreenBudget;
  /** The model profile to run. */
  model: ScreenModel;
}

/**
 * The screen's verdict on one planted copy:
 * - `located`: at least one attempt found the planted change from the source alone, so the
 *   candidate fails the static-headroom screen;
 * - `not_located`: no attempt found it, so the candidate survives;
 * - `inconclusive`: the screen could not decide (for example, every attempt errored).
 */
export type ScreenVerdict = "located" | "not_located" | "inconclusive";

export interface ScreenResult {
  verdict: ScreenVerdict;
  /** Attempts that pointed at the planted change. */
  hits: number;
  /** Attempts made. */
  attempts: number;
  /** What the screen spent, in micro-USD. */
  costMicrousd: number;
}

export type Screen = (job: ScreenJob) => Promise<ScreenResult> | ScreenResult;
