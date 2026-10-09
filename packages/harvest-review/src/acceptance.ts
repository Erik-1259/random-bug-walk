// The acceptance set: small hand-written synthetic changes with the vote each model must give.
// Positives must get `yes`; negatives must never get `yes`. The `acceptance` command runs the
// cases chosen with --cases through `review` and reports, per model, which of them passed. The
// whole set is more than one run's cap, so it takes two runs.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { addedLines, examineFile } from "@rbw/harvest";
import { buildCandidateInput } from "./inputs.ts";
import type { ReviewInputs } from "./inputs.ts";
import { REVIEW_MODELS } from "./profiles.ts";
import type { ModelName } from "./profiles.ts";
import { executeReview, MAX_CANDIDATES } from "./review.ts";
import type { ReviewOptions } from "./review.ts";

export interface AcceptanceCase {
  readonly name: string;
  readonly expected: "yes" | "not_yes";
  readonly path: string;
  readonly before: string;
  readonly after: string;
  /** The call under review in `after`, and the line it starts on. */
  readonly line: number;
  readonly call: string;
}

const UMAMI_BEFORE = `export async function getPageviewStats(websiteId: string, filters: QueryFilters) {
  const { timezone = "utc", unit = "day" } = filters;
  return rawQuery(
    \`select \${getDateSQL("website_event.created_at", unit)} x, count(*) y from website_event\`,
    { websiteId },
  );
}
`;

const OPTIONS_BEFORE = `export function joinedOn(user: { createdAt: Date; timezone: string }, locale: string) {
  return user.createdAt.toLocaleDateString(locale);
}
`;

const MEMBER_BEFORE = `export function bucketStart(date: Date, unit: string, filters: { timezone: string }) {
  return getStartOfPeriod(date, unit);
}
`;

const PREFERENCES_BEFORE = `export async function saveSettings(userId: string, timezone: string) {
  await updatePreferences(userId);
}
`;

const OFFSET_BEFORE = `export function label(d: Date, timezoneOffset: number) {
  return formatDate(d);
}
`;

const CONST_BEFORE = `export function label(d: Date) {
  return formatDate(d);
}
`;

const SHADOW_BEFORE = `export function label(d: Date, timezone: string, fixed: boolean) {
  if (fixed) {
    const timezone = "UTC";
    return formatDate(d);
  }
  return formatDate(d, timezone);
}
`;

const REPLACED_BEFORE = `export function label(d: Date, timezone: string) {
  return format(d, "yyyy-MM-dd");
}
`;

const SIBLING_BEFORE = `export function renderRows(rows: Row[], timezone: string) {
  rows.forEach((row) => {
    print(formatDate(row.date));
  });
  return rows.map((row) => row.id);
}
`;

const GUESS_BEFORE = `export function label(d: Date) {
  return d.toLocaleString("en-US");
}
`;

export const ACCEPTANCE_CASES: readonly AcceptanceCase[] = [
  {
    name: "umami-style-fix",
    expected: "yes",
    path: "src/queries/pageviews.ts",
    before: UMAMI_BEFORE,
    after: UMAMI_BEFORE.replace('getDateSQL("website_event.created_at", unit)', 'getDateSQL("website_event.created_at", unit, timezone)'),
    line: 4,
    call: 'getDateSQL("website_event.created_at", unit, timezone)',
  },
  {
    name: "options-user-timezone",
    expected: "yes",
    path: "src/joined.ts",
    before: OPTIONS_BEFORE,
    after: OPTIONS_BEFORE.replace("toLocaleDateString(locale)", "toLocaleDateString(locale, { timeZone: user.timezone })"),
    line: 2,
    call: "user.createdAt.toLocaleDateString(locale, { timeZone: user.timezone })",
  },
  {
    name: "member-filters-timezone",
    expected: "yes",
    path: "src/buckets.ts",
    before: MEMBER_BEFORE,
    after: MEMBER_BEFORE.replace("getStartOfPeriod(date, unit)", "getStartOfPeriod(date, unit, filters.timezone)"),
    line: 2,
    call: "getStartOfPeriod(date, unit, filters.timezone)",
  },
  {
    name: "not-a-date-operation",
    expected: "not_yes",
    path: "src/settings.ts",
    before: PREFERENCES_BEFORE,
    after: PREFERENCES_BEFORE.replace("updatePreferences(userId)", "updatePreferences(userId, timezone)"),
    line: 2,
    call: "updatePreferences(userId, timezone)",
  },
  {
    name: "timezone-offset",
    expected: "not_yes",
    path: "src/offset.ts",
    before: OFFSET_BEFORE,
    after: OFFSET_BEFORE.replace("formatDate(d)", "formatDate(d, timezoneOffset)"),
    line: 2,
    call: "formatDate(d, timezoneOffset)",
  },
  {
    name: "utc-as-const",
    expected: "not_yes",
    path: "src/const.ts",
    before: CONST_BEFORE,
    after: CONST_BEFORE.replace("  return formatDate(d);", '  const timezone = "UTC" as const;\n  return formatDate(d, timezone);'),
    line: 3,
    call: "formatDate(d, timezone)",
  },
  {
    name: "shadowing-inner-utc",
    expected: "not_yes",
    path: "src/shadow.ts",
    before: SHADOW_BEFORE,
    after: SHADOW_BEFORE.replace("    return formatDate(d);", "    return formatDate(d, timezone);"),
    line: 4,
    call: "formatDate(d, timezone)",
  },
  {
    name: "replaced-call",
    expected: "not_yes",
    path: "src/replaced.ts",
    before: REPLACED_BEFORE,
    after: REPLACED_BEFORE.replace('format(d, "yyyy-MM-dd")', 'formatInTimeZone(d, timezone, "yyyy-MM-dd")'),
    line: 2,
    call: 'formatInTimeZone(d, timezone, "yyyy-MM-dd")',
  },
  {
    name: "moved-to-sibling-callback",
    expected: "not_yes",
    path: "src/rows.ts",
    before: SIBLING_BEFORE,
    after: SIBLING_BEFORE.replace("    print(formatDate(row.date));", "    print(row.id);").replace(
      "rows.map((row) => row.id)",
      "rows.map((row) => formatDate(row.date, timezone))",
    ),
    line: 5,
    call: "formatDate(row.date, timezone)",
  },
  {
    name: "runtime-zone-guess",
    expected: "not_yes",
    path: "src/guess.ts",
    before: GUESS_BEFORE,
    after: GUESS_BEFORE.replace('toLocaleString("en-US")', 'toLocaleString("en-US", { timeZone: dayjs.tz.guess() })'),
    line: 2,
    call: 'd.toLocaleString("en-US", { timeZone: dayjs.tz.guess() })',
  },
];

/** One hunk that replaces the differing middle lines, with no context lines. */
function singleHunk(before: string, after: string): string {
  const old = before.split("\n");
  const neu = after.split("\n");
  let start = 0;
  while (start < old.length && start < neu.length && old[start] === neu[start]) {
    start += 1;
  }
  let endOld = old.length;
  let endNew = neu.length;
  while (endOld > start && endNew > start && old[endOld - 1] === neu[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  const lines = [...old.slice(start, endOld).map((line) => `-${line}`), ...neu.slice(start, endNew).map((line) => `+${line}`)];
  return `@@ -${String(start + 1)},${String(endOld - start)} +${String(start + 1)},${String(endNew - start)} @@\n${lines.join("\n")}`;
}

const ACCEPTANCE_REPO = "synthetic-acceptance";

/**
 * The cases at the given 0-based indices, or the whole set, as review inputs. The ast-grep outcome
 * is what the harvest's checks give the call, or no match. Each case keeps its commit, so its
 * candidate key is the same in any selection.
 */
export function acceptanceInputs(indices: readonly number[] = ACCEPTANCE_CASES.map((_entry, index) => index)): ReviewInputs {
  const candidates = ACCEPTANCE_CASES.map((entry, index) => {
    const patch = singleHunk(entry.before, entry.after);
    const match = examineFile(entry.path, entry.before, entry.after, addedLines(patch)).find(
      (found) => found.line === entry.line && found.call === entry.call,
    );
    const astGrep = match === undefined ? "no_rule_match_on_added_line" : match.outcome.status === "confirmed" ? "confirmed" : match.outcome.reason;
    return buildCandidateInput({
      candidate_id: `${ACCEPTANCE_REPO}/${entry.name}`,
      repo: ACCEPTANCE_REPO,
      commit: (index + 1).toString(16).padStart(40, "0"),
      path: entry.path,
      previous_path: null,
      before: entry.before,
      after: entry.after,
      patch,
      line: entry.line,
      call: entry.call,
      ast_grep: astGrep,
    });
  });
  return { format_version: 1, candidates: indices.map((index) => candidates[index]).filter((entry) => entry !== undefined) };
}

/**
 * Parses --cases: comma-separated 1-based case numbers or ranges such as `1-5`, at most the run's
 * cap and no case twice. Returns the 0-based indices in set order, or null when invalid.
 */
export function parseCases(value: string | undefined): number[] | null {
  if (value === undefined) {
    return null;
  }
  const chosen = new Set<number>();
  for (const item of value.split(",")) {
    const range = /^([0-9]+)(?:-([0-9]+))?$/.exec(item);
    if (range === null) {
      return null;
    }
    const first = Number(range[1]);
    const last = range[2] === undefined ? first : Number(range[2]);
    if (first < 1 || last > ACCEPTANCE_CASES.length || first > last) {
      return null;
    }
    for (let number = first; number <= last; number += 1) {
      if (chosen.has(number - 1)) {
        return null;
      }
      chosen.add(number - 1);
    }
  }
  return chosen.size <= MAX_CANDIDATES ? [...chosen].sort((a, b) => a - b) : null;
}

const USAGE = "usage: acceptance --rate-sheet <rates.json> --out <new dir> --slot-key <key> --pool <pool-key> --cases <1-5 | 6-10 | list>";

export async function runAcceptance(options: ReviewOptions): Promise<number> {
  const say = (line: string): void => {
    options.write(`${line}\n`);
  };
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({
      args: options.argv,
      strict: true,
      allowPositionals: false,
      options: {
        "rate-sheet": { type: "string" },
        out: { type: "string" },
        "slot-key": { type: "string" },
        pool: { type: "string" },
        cases: { type: "string" },
      },
    }).values;
  } catch {
    say(`acceptance: ${USAGE}`);
    return 2;
  }
  const { out, pool } = values;
  const ratePath = values["rate-sheet"];
  const slotKey = values["slot-key"];
  if (!ratePath || !out || !slotKey || !pool) {
    say(`acceptance: ${USAGE}`);
    return 2;
  }
  const indices = parseCases(values.cases);
  if (indices === null) {
    say(`acceptance: --cases must name from 1 to ${String(MAX_CANDIDATES)} of cases 1-${String(ACCEPTANCE_CASES.length)}, each once`);
    return 2;
  }
  let rateSheet: Uint8Array;
  try {
    rateSheet = await readFile(ratePath);
  } catch {
    say("acceptance: unknown_price: the rate file cannot be read");
    return 1;
  }
  const inputs = acceptanceInputs(indices);
  const { code, review } = await executeReview(options, { inputs, rateSheet, out, slotKey, pool, maxCandidates: inputs.candidates.length });
  if (review === null) {
    return code;
  }
  const selected = indices.map((index) => ACCEPTANCE_CASES[index]).filter((entry) => entry !== undefined);
  const cases = selected.map((entry, position) => {
    const result = review.candidates[position];
    const votes = Object.fromEntries(REVIEW_MODELS.map((model) => [model.name, result?.votes[model.name]?.vote ?? null])) as Record<ModelName, string | null>;
    const passed = Object.fromEntries(
      REVIEW_MODELS.map((model) => {
        const given = votes[model.name];
        return [model.name, given !== null && (entry.expected === "yes" ? given === "yes" : given !== "yes")];
      }),
    ) as Record<ModelName, boolean>;
    return { case: entry.name, expected: entry.expected, ast_grep: result?.ast_grep ?? null, votes, passed };
  });
  const models = Object.fromEntries(
    REVIEW_MODELS.map((model) => [
      model.name,
      {
        passed: cases.filter((entry) => entry.passed[model.name]).map((entry) => entry.case),
        failed: cases.filter((entry) => !entry.passed[model.name]).map((entry) => entry.case),
      },
    ]),
  ) as Record<ModelName, { passed: string[]; failed: string[] }>;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "acceptance.json"), `${JSON.stringify({ format_version: 1, cases, models }, null, 2)}\n`);
  for (const model of REVIEW_MODELS) {
    const { passed, failed } = models[model.name];
    say(
      `acceptance: ${model.name}: ${String(passed.length)} of ${String(cases.length)} passed${failed.length === 0 ? "" : `; failed: ${failed.join(", ")}`}`,
    );
  }
  const allPassed = REVIEW_MODELS.every((model) => models[model.name].failed.length === 0);
  return code === 0 && allPassed ? 0 : 1;
}
