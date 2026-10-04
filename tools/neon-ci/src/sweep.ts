import { listBranches } from "./api.ts";
import type { Branch, Deps } from "./api.ts";
import type { Config } from "./config.ts";
import { deleteAndConfirm } from "./delete.ts";
import type { Outcome } from "./delete.ts";
import { isCiBranchName } from "./naming.ts";

export type SweepOutcome = Outcome | "would-delete";

export interface Selected {
  branch: Branch;
  /** Whole minutes since creation; undefined when `created_at` is missing or unparseable. */
  ageMinutes: number | undefined;
}

export interface Selection {
  selected: Selected[];
  /** Pattern-matching branches whose `created_at` cannot be used. */
  unknown: Branch[];
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Strict RFC 3339 parse to epoch milliseconds; calendar-invalid dates give undefined. */
export function parseRfc3339(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = RFC3339.exec(value);
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const offset = match[7] ?? "";
  const probe = new Date(Date.UTC(year, month - 1, day));
  const calendarValid =
    probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
  const offsetHours = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinutes = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  if (!calendarValid || hour > 23 || minute > 59 || second > 60 || offsetHours > 23 || offsetMinutes > 59) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Picks CI branches that are old enough; everything else is left alone. */
export function selectStale(branches: readonly Branch[], nowMs: number, minAgeMinutes: number): Selection {
  const selected: Selected[] = [];
  const unknown: Branch[] = [];
  for (const branch of branches) {
    if (!isCiBranchName(branch.name) || branch.isDefault || branch.isProtected) continue;
    const created = parseRfc3339(branch.createdAt);
    if (created === undefined) {
      unknown.push(branch);
      continue;
    }
    const ageMs = nowMs - created;
    if (ageMs < 0 || ageMs < minAgeMinutes * 60_000) continue;
    selected.push({ branch, ageMinutes: Math.floor(ageMs / 60_000) });
  }
  return { selected, unknown };
}

export interface SweepReport {
  lines: string[];
  summary: string;
  exitCode: 0 | 1 | 2;
}

export async function runSweep(
  deps: Deps,
  config: Config,
  minAgeMinutes: number,
  dryRun: boolean,
): Promise<SweepReport> {
  const listed = await listBranches(deps, config);
  if ("unreadable" in listed) {
    return { lines: [], summary: `sweep failed: ${listed.unreadable}`, exitCode: 2 };
  }
  const { selected, unknown } = selectStale(listed.branches, deps.now(), minAgeMinutes);
  const counts: Record<SweepOutcome, number> = { deleted: 0, absent: 0, leaked: 0, unknown: 0, "would-delete": 0 };
  const lines: string[] = [];
  for (const { branch, ageMinutes } of selected) {
    const outcome: SweepOutcome = dryRun ? "would-delete" : (await deleteAndConfirm(deps, config, branch.name, branch.id)).outcome;
    counts[outcome]++;
    lines.push(`name=${branch.name} age_minutes=${String(ageMinutes)} outcome=${outcome}`);
  }
  for (const branch of unknown) {
    counts.unknown++;
    lines.push(`name=${branch.name} age_minutes=- outcome=unknown`);
  }
  const summary =
    `sweep selected=${String(selected.length + unknown.length)} deleted=${String(counts.deleted)} ` +
    `absent=${String(counts.absent)} leaked=${String(counts.leaked)} unknown=${String(counts.unknown)} ` +
    `would-delete=${String(counts["would-delete"])} dry_run=${String(dryRun)}`;
  const exitCode = counts.unknown > 0 ? 2 : counts.leaked > 0 ? 1 : 0;
  return { lines, summary, exitCode };
}
