import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { RecordError, parseRecord, validateRecord, type RootRun, type StagingOmissions } from "@rbw/schema";
import { InvalidInput } from "./errors.ts";
import type { RedactionValue } from "./sanitize.ts";

export const OMISSIONS_FILE = "omissions.json";
export const REPORT_FILE = "report.md";
const CATEGORIES = new Set(["inputs", "generated", "logs", "results"]);
const UUID_SHAPED = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Path and trial rules come from the shared schema, never from a local copy. */
const isRelativePath = (path: string): boolean => validateRecord("RelativePath", path).length === 0;
const isTrialId = (value: string): boolean => validateRecord("TrialId", value).length === 0;

export interface StagedFile {
  path: string;
  bytes: Buffer;
  executionId: string;
  trialId: string | null;
}

export interface StagedRun {
  files: StagedFile[];
  omissions: StagingOmissions;
}

interface Owner {
  executionId: string;
  trialId: string | null;
}

/**
 * Derives the execution and trial a run path belongs to. Child files live under
 * `<category>/<child_execution_id>/`, with `<trial_id>/` below that when the file is deeper.
 */
export function ownerOf(path: string, root: RootRun): Owner {
  const segments = path.split("/");
  if (!isRelativePath(path)) throw new InvalidInput("staging_path");
  const [top = "", second, third] = segments;
  // Only the segment right after the category may name an execution.
  if (segments.slice(2).some((segment) => UUID_SHAPED.test(segment))) throw new InvalidInput("staging_unexpected_execution_segment");
  if (segments.length === 1) {
    if (top !== REPORT_FILE) throw new InvalidInput("staging_top_level");
    return { executionId: root.root_execution_id, trialId: null };
  }
  if (!CATEGORIES.has(top)) throw new InvalidInput("staging_top_level");
  if (second === undefined || !UUID_SHAPED.test(second)) return { executionId: root.root_execution_id, trialId: null };
  if (second !== root.root_execution_id && !root.child_execution_ids.includes(second)) throw new InvalidInput("staging_unknown_execution");
  if (segments.length <= 3 || third === undefined) return { executionId: second, trialId: null };
  if (!isTrialId(third)) throw new InvalidInput("staging_trial");
  return { executionId: second, trialId: third };
}

function readRegularFile(path: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new InvalidInput("staging_unreadable");
  }
  try {
    if (!fstatSync(fd).isFile()) throw new InvalidInput("staging_special_file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function lstat(path: string): Stats {
  try {
    return lstatSync(path);
  } catch {
    throw new InvalidInput("staging_unreadable");
  }
}

function contains(haystack: string, values: readonly RedactionValue[]): boolean {
  const bytes = Buffer.from(haystack);
  return values.some((item) => bytes.includes(Buffer.from(item.value)));
}

/** Lists every entry below the staging root, checking names, types and case collisions. */
function walk(dir: string): { files: string[]; omissionsPresent: boolean } {
  const root = lstat(dir);
  if (!root.isDirectory()) throw new InvalidInput("staging_not_directory");
  const files: string[] = [];
  const seen = new Set<string>();
  let omissionsPresent = false;
  const visit = (relative: string): void => {
    let names: string[];
    try {
      names = readdirSync(join(dir, relative)).sort();
    } catch {
      throw new InvalidInput("staging_unreadable");
    }
    for (const name of names) {
      if (!isRelativePath(name)) throw new InvalidInput("staging_segment");
      const path = relative === "" ? name : `${relative}/${name}`;
      const folded = path.toLowerCase();
      if (seen.has(folded)) throw new InvalidInput("staging_case_collision");
      seen.add(folded);
      const stats = lstat(join(dir, path));
      if (relative === "") {
        const allowed = CATEGORIES.has(name) ? stats.isDirectory() : (name === REPORT_FILE || name === OMISSIONS_FILE) && stats.isFile();
        if (!allowed) throw new InvalidInput("staging_top_level");
        if (name === OMISSIONS_FILE) {
          omissionsPresent = true;
          continue;
        }
      }
      if (stats.isDirectory()) visit(path);
      else if (stats.isFile()) files.push(path);
      else throw new InvalidInput("staging_special_file");
    }
  };
  visit("");
  return { files, omissionsPresent };
}

function readOmissions(dir: string, present: boolean): StagingOmissions {
  if (!present) return { schema_version: 1, entries: [], redactions: [] };
  try {
    return parseRecord("StagingOmissions", readRegularFile(join(dir, OMISSIONS_FILE)));
  } catch (error) {
    if (error instanceof RecordError) throw new InvalidInput("omissions_invalid");
    throw error;
  }
}

function checkOmissions(omissions: StagingOmissions, staged: readonly string[], root: RootRun): void {
  const stagedSet = new Set(staged);
  const folded = new Set(staged.map((path) => path.toLowerCase()));
  const executions = new Set([root.root_execution_id, ...root.child_execution_ids]);
  for (const entry of omissions.entries) {
    if (!executions.has(entry.execution_id)) throw new InvalidInput("omissions_unknown_execution");
    if (!("path" in entry)) continue;
    const owner = ownerOf(entry.path, root);
    if (owner.executionId !== entry.execution_id || owner.trialId !== entry.trial_id) throw new InvalidInput("omissions_owner_mismatch");
    if (entry.outcome === "truncated" && !stagedSet.has(entry.path)) throw new InvalidInput("omissions_truncated_not_staged");
    if (entry.outcome === "not_produced") {
      const prefix = `${entry.path.toLowerCase()}/`;
      if (folded.has(entry.path.toLowerCase()) || staged.some((path) => path.toLowerCase().startsWith(prefix) || prefix.startsWith(`${path.toLowerCase()}/`))) {
        throw new InvalidInput("omissions_not_produced_staged");
      }
    }
  }
  for (const redaction of omissions.redactions) {
    if (!stagedSet.has(redaction.path)) throw new InvalidInput("omissions_redaction_not_staged");
  }
}

/** Reads and validates a staging directory. Nothing in it is modified. */
export function readStaging(dir: string, root: RootRun, values: readonly RedactionValue[]): StagedRun {
  const { files: paths, omissionsPresent } = walk(dir);
  const omissions = readOmissions(dir, omissionsPresent);
  const declared = omissions.entries.flatMap((entry) => ("path" in entry ? [entry.path] : []));
  if ([...paths, ...declared].some((path) => contains(path, values))) throw new InvalidInput("staged_path_contains_listed_value");
  // Every other private-input string that reaches the manifest is checked the same way.
  const strings = [
    ...omissions.entries.flatMap((entry) => (entry.trial_id === null ? [] : [entry.trial_id])),
    ...root.declared_stages,
    root.root_execution_id,
    ...root.child_execution_ids,
  ];
  if (strings.some((value) => contains(value, values))) throw new InvalidInput("staged_value_contains_listed_value");
  const files = paths.map((path): StagedFile => {
    const owner = ownerOf(path, root);
    return { path, bytes: readRegularFile(join(dir, path)), executionId: owner.executionId, trialId: owner.trialId };
  });
  checkOmissions(omissions, paths, root);
  return { files, omissions };
}
