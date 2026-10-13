// The shapes a harvest can run for. A shape names its queries, its candidate rule, the cheap text
// filter applied to a file's added lines before any blob is fetched, and its structural
// confirmation. DT-1.tz-arg (time zone not passed to a date operation) is the default; the race
// class is RC-1.guarded-write (a write that re-checks the state it read, as compare and swap).
import { SHAPE_ID } from "@rbw/shapes";
import { QUERY_FILE, RACE_QUERY_FILE } from "./queries.ts";
import { examineFile, TIMEZONE_TEXT, TZ_CANDIDATE_RULES, type FileMatch } from "./confirm.ts";
import { examineRaceFile, RACE_CANDIDATE_RULES, RACE_CONFIRM_REASONS, RACE_SHAPE_ID, WRITE_TEXT, type RaceFileMatch } from "./race.ts";
import type { CandidateRules } from "./rule-file.ts";

/** A rule match of any shape. */
export type AnyFileMatch = FileMatch | RaceFileMatch;

export interface HarvestShape {
  readonly id: string;
  readonly rules: CandidateRules;
  /** The source-rule record the funnel carries (its SHA-256 is added from the rule file's bytes). */
  readonly source_rule: {
    readonly basis: "candidate_rule";
    readonly file: string;
    readonly ids: readonly string[];
    readonly reason: string;
  };
  /** The query file a live harvest runs by default. */
  readonly query_file: string;
  /** The cheap filter on a file's added lines, its drop reason and the words used in drop details. */
  readonly text_filter: RegExp;
  readonly no_text_reason: string;
  readonly text_label: string;
  /** The structural drop reasons, in check order. */
  readonly confirm_reasons: readonly string[];
  examineFile(path: string, before: string, after: string, added: ReadonlySet<number>): AnyFileMatch[];
}

export const DT1_HARVEST_SHAPE: HarvestShape = {
  id: SHAPE_ID,
  rules: TZ_CANDIDATE_RULES,
  source_rule: {
    basis: "candidate_rule",
    file: "packages/harvest/rules/tz-arg.candidate.yml",
    ids: [TZ_CANDIDATE_RULES.ids.TypeScript, TZ_CANDIDATE_RULES.ids.Tsx],
    reason:
      "The shape's source rule dt-1.tz-arg.source in @rbw/shapes is pinned to one upstream component and commit, " +
      "so candidates are matched with this package's rule for the candidate's call.",
  },
  query_file: QUERY_FILE,
  text_filter: TIMEZONE_TEXT,
  no_text_reason: "no_timezone_text_added",
  text_label: "time-zone text",
  confirm_reasons: ["function_missing_before", "call_added", "before_has_timezone_argument", "timezone_is_constant", "timezone_unbound"],
  examineFile,
};

export const RACE_HARVEST_SHAPE: HarvestShape = {
  id: RACE_SHAPE_ID,
  rules: RACE_CANDIDATE_RULES,
  source_rule: {
    basis: "candidate_rule",
    file: "packages/harvest/rules/race-guard.candidate.yml",
    ids: [RACE_CANDIDATE_RULES.ids.TypeScript, RACE_CANDIDATE_RULES.ids.Tsx],
    reason:
      "The race family's source rule rc-1.atomic-backup-code.source in @rbw/shapes is pinned to one upstream handler and commit, " +
      "so candidates are matched with this package's rule for a write with a filter.",
  },
  query_file: RACE_QUERY_FILE,
  text_filter: WRITE_TEXT,
  no_text_reason: "no_write_text_added",
  text_label: "write text",
  confirm_reasons: RACE_CONFIRM_REASONS,
  examineFile: examineRaceFile,
};

export const HARVEST_SHAPES: readonly HarvestShape[] = [DT1_HARVEST_SHAPE, RACE_HARVEST_SHAPE];

export class UnknownShape extends Error {
  override name = "UnknownShape";
}

/** The harvest shape with this ID. Throws UnknownShape for any other. */
export function harvestShape(id: string): HarvestShape {
  const shape = HARVEST_SHAPES.find((entry) => entry.id === id);
  if (shape === undefined) {
    throw new UnknownShape(`no harvest shape ${id}; known shapes: ${HARVEST_SHAPES.map((entry) => entry.id).join(", ")}`);
  }
  return shape;
}
