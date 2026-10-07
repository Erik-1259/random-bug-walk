// The funnel for shape DT-1.tz-arg over GitHub search results. It reads only through a Transport,
// so a live run and a replay of its frozen responses go through the same code and give the same
// funnel. Search results are taken round-robin across the queries, so every query that answers
// contributes before the cap. Each candidate stops at its first drop. Candidates are checked in
// harvest order up to their commit, de-duplicated by commit SHA and then by patch ID, keeping the
// earliest commit, and the rest are checked one at a time.
import { createHash } from "node:crypto";
import { SHAPE_ID } from "@rbw/shapes";
import { addedLines, addedText, candidateRuleBytes, CANDIDATE_RULE_IDS, examineFile, SOURCE_FILE, TIMEZONE_TEXT, type FileMatch } from "./confirm.ts";
import type { Transport } from "./frozen.ts";
import { schemas, urls, type Commit, type CommitFile, type Content, type SearchCommits } from "./github-api.ts";
import { licenseDecision } from "./license.ts";
import { searchUrl, type Query } from "./queries.ts";

export const STAGES = ["harvested", "license_permitted", "diff_fetched", "source_rule_matched", "structurally_confirmed"] as const;
export type Stage = (typeof STAGES)[number];

/** Every reason a candidate can drop, by the stage it failed to reach. */
export const DROP_REASONS: Readonly<Record<Stage, readonly string[]>> = {
  harvested: [],
  license_permitted: ["repo_unavailable", "fork", "license_missing", "license_unrecognized", "license_not_permitted"],
  diff_fetched: [
    "pr_unavailable",
    "pr_not_merged",
    "commit_unavailable",
    "duplicate_commit",
    "duplicate_patch",
    "not_single_parent",
    "too_many_files",
    "no_ts_js_change",
    "patch_missing",
    "blob_unavailable",
    "blob_too_large",
    "blob_mismatch",
  ],
  source_rule_matched: ["no_timezone_text_added", "no_rule_match_on_added_line"],
  structurally_confirmed: ["function_missing_before", "call_added", "before_has_timezone_argument", "timezone_is_constant", "timezone_unbound"],
};

/** GitHub's commit endpoint lists at most this many files on one page. */
const MAX_COMMIT_FILES = 300;
/** At most this many files per candidate have their blobs fetched. */
const MAX_TIMEZONE_FILES = 10;

export const SOURCE_RULE = {
  basis: "candidate_rule",
  file: "packages/harvest/rules/tz-arg.candidate.yml",
  ids: [CANDIDATE_RULE_IDS.TypeScript, CANDIDATE_RULE_IDS.Tsx],
  reason:
    "The shape's source rule dt-1.tz-arg.source in @rbw/shapes is pinned to one upstream component and commit, " +
    "so candidates are matched with this package's rule for the candidate's call.",
} as const;

export interface DropCount {
  readonly stage: Stage;
  readonly reason: string;
  readonly count: number;
}

export interface QueryRecord {
  readonly kind: Query["kind"];
  readonly api: string;
  readonly q: string;
  readonly status: number;
  readonly total_count: number | null;
  readonly items: number;
  readonly added: number;
  /** How many of this query's candidates reached each stage. */
  readonly stages: Readonly<Record<Stage, number>>;
  /** This query's drop reasons, most frequent first. */
  readonly drops: readonly DropCount[];
}

export interface Confirmation {
  readonly license: string;
  readonly commit: string;
  readonly parent: string;
  readonly path: string;
  readonly before_blob: string;
  readonly after_blob: string;
  readonly line: number;
  readonly call: string;
  readonly callee: string;
  readonly function: string;
  readonly before_line: number;
  readonly before_call: string;
  readonly timezone: string;
}

/** Where a permitted license was read: the search result, the repository record or the license endpoint. */
export type LicenseSource = "search" | "repository" | "license_endpoint";

export interface CandidateRecord {
  readonly id: string;
  readonly query: number;
  readonly repo: string;
  readonly pull: number | null;
  commit: string | null;
  license: string | null;
  license_source: LicenseSource | null;
  committed_at: string | null;
  patch_id: string | null;
  stage_reached: Stage;
  drop: { readonly stage: Stage; readonly reason: string; readonly detail: string } | null;
  matches: (FileMatch & { readonly path: string })[];
  confirmation: Confirmation | null;
}

export interface StageRecord {
  readonly stage: Stage;
  readonly count: number;
  readonly drops: Readonly<Record<string, number>>;
}

export interface FunnelCore {
  readonly schema_version: 2;
  readonly shape_id: string;
  readonly source_rule: typeof SOURCE_RULE & { readonly sha256: string };
  readonly queries: readonly QueryRecord[];
  readonly stages: readonly StageRecord[];
  readonly candidates: readonly CandidateRecord[];
}

class Drop extends Error {
  readonly stage: Stage;
  readonly reason: string;

  constructor(stage: Stage, reason: string, detail: string) {
    super(detail);
    this.stage = stage;
    this.reason = reason;
  }
}

type SearchRepository = SearchCommits["items"][number]["repository"];

interface Hit {
  readonly repo: string;
  readonly pull: number | null;
  readonly commit: string | null;
  readonly repository: SearchRepository | null;
}

type HarvestedQuery = Omit<QueryRecord, "stages" | "drops">;

function gitBlobSha1(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${String(bytes.length)}\0`).update(bytes).digest("hex");
}

function repoFromUrl(url: string): string | undefined {
  return /\/repos\/([^/]+\/[^/]+)$/.exec(url)?.[1];
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A patch ID in the manner of `git patch-id`: a hash of each file's name and its added and removed
 * lines with whitespace and line numbers ignored, so the same change committed elsewhere has the
 * same ID. A file GitHub gives no patch for counts by its blob ID. Null when no file has a patch.
 */
export function patchId(files: readonly CommitFile[]): string | null {
  if (!files.some((file) => file.patch !== undefined)) {
    return null;
  }
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => byText(a.filename, b.filename))) {
    hash.update(`${file.filename}\0`);
    if (file.patch === undefined) {
      hash.update(`blob ${file.sha ?? ""}\n`);
      continue;
    }
    for (const line of file.patch.split("\n")) {
      if (line.startsWith("+") || line.startsWith("-")) {
        hash.update(`${line.charAt(0)}${line.slice(1).replace(/\s+/g, "")}\n`);
      }
    }
  }
  return hash.digest("hex");
}

/** Drop reasons by count, most frequent first, then in stage order, then by name. */
export function rankDrops(candidates: readonly Pick<CandidateRecord, "drop">[]): DropCount[] {
  const counts = new Map<string, DropCount>();
  for (const { drop } of candidates) {
    if (drop !== null) {
      const key = `${drop.stage}\0${drop.reason}`;
      counts.set(key, { stage: drop.stage, reason: drop.reason, count: (counts.get(key)?.count ?? 0) + 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || byText(a.reason, b.reason));
}

function stageCounts(candidates: readonly CandidateRecord[]): Record<Stage, number> {
  const counts = Object.fromEntries(STAGES.map((stage) => [stage, 0])) as Record<Stage, number>;
  for (const candidate of candidates) {
    for (const stage of STAGES.slice(0, STAGES.indexOf(candidate.stage_reached) + 1)) {
      counts[stage] += 1;
    }
  }
  return counts;
}

async function search(transport: Transport, query: Query): Promise<{ record: HarvestedQuery; hits: Hit[] }> {
  const response = await transport.get(searchUrl(query));
  const base = { kind: query.kind, api: query.api, q: query.q, status: response.status };
  if (response.status !== 200) {
    return { record: { ...base, total_count: null, items: 0, added: 0 }, hits: [] };
  }
  const hits: Hit[] = [];
  let total: number;
  if (query.kind === "commits") {
    const body = schemas.searchCommits.parse(response.body);
    total = body.total_count;
    for (const item of body.items) {
      hits.push({ repo: item.repository.full_name, pull: null, commit: item.sha, repository: item.repository });
    }
    return { record: { ...base, total_count: total, items: body.items.length, added: 0 }, hits };
  }
  const body = schemas.searchIssues.parse(response.body);
  for (const item of body.items) {
    const repo = repoFromUrl(item.repository_url);
    if (item.pull_request !== undefined && repo !== undefined) {
      hits.push({ repo, pull: item.number, commit: null, repository: null });
    }
  }
  return { record: { ...base, total_count: body.total_count, items: body.items.length, added: 0 }, hits };
}

async function harvestCandidates(
  transport: Transport,
  queries: readonly Query[],
  max: number,
): Promise<{ queries: HarvestedQuery[]; candidates: CandidateRecord[]; searched: Map<string, SearchRepository> }> {
  const pages: { record: HarvestedQuery; hits: Hit[] }[] = [];
  for (const query of queries) {
    pages.push(await search(transport, query));
  }
  const candidates: CandidateRecord[] = [];
  const searched = new Map<string, SearchRepository>();
  const ids = new Set<string>();
  const depth = Math.max(0, ...pages.map((page) => page.hits.length));
  for (let position = 0; position < depth && candidates.length < max; position += 1) {
    for (const [query, page] of pages.entries()) {
      const hit = page.hits[position];
      if (hit === undefined || candidates.length >= max) {
        continue;
      }
      const id = hit.pull === null ? `${hit.repo}@${hit.commit ?? ""}` : `${hit.repo}#${String(hit.pull)}`;
      if (ids.has(id)) {
        continue;
      }
      ids.add(id);
      if (hit.repository !== null && !searched.has(hit.repo)) {
        searched.set(hit.repo, hit.repository);
      }
      page.record = { ...page.record, added: page.record.added + 1 };
      candidates.push({
        id,
        query,
        repo: hit.repo,
        pull: hit.pull,
        commit: hit.commit,
        license: null,
        license_source: null,
        committed_at: null,
        patch_id: null,
        stage_reached: "harvested",
        drop: null,
        matches: [],
        confirmation: null,
      });
    }
  }
  return { queries: pages.map((page) => page.record), candidates, searched };
}

/**
 * The repository checks. The fork flag comes from the search result, or from the repository record
 * when the result lacks it. The license comes from the search result, then the repository record if
 * it was read, then the license endpoint. The transport answers a repeated request from its record,
 * so each repository's record and license are fetched at most once.
 */
async function checkRepository(transport: Transport, candidate: CandidateRecord, searched: ReadonlyMap<string, SearchRepository>): Promise<string> {
  const hit = searched.get(candidate.repo);
  let fork = hit?.fork;
  let spdx = hit?.license?.spdx_id ?? null;
  let source: LicenseSource = "search";
  if (fork === undefined) {
    const response = await transport.get(urls.repository(candidate.repo));
    if (response.status !== 200) {
      throw new Drop("license_permitted", "repo_unavailable", `the repository returned ${String(response.status)}`);
    }
    const record = schemas.repository.parse(response.body);
    fork = record.fork;
    if (spdx === null) {
      spdx = record.license?.spdx_id ?? null;
      source = "repository";
    }
  }
  if (fork) {
    throw new Drop("license_permitted", "fork", "the repository is a fork");
  }
  if (spdx === null) {
    const response = await transport.get(urls.license(candidate.repo));
    if (response.status === 200) {
      spdx = schemas.license.parse(response.body).license?.spdx_id ?? null;
      source = "license_endpoint";
    } else if (response.status !== 404) {
      throw new Drop("license_permitted", "repo_unavailable", `the license endpoint returned ${String(response.status)}`);
    }
  }
  const decision = licenseDecision(spdx === null ? null : { spdx_id: spdx });
  if (!decision.permitted) {
    const detail = spdx === null ? "neither the search result, the repository record nor the license endpoint names a license" : decision.detail;
    throw new Drop("license_permitted", decision.reason, detail);
  }
  candidate.license = decision.spdx;
  candidate.license_source = source;
  candidate.stage_reached = "license_permitted";
  return decision.spdx;
}

interface Resolved {
  readonly candidate: CandidateRecord;
  readonly order: number;
  readonly license: string;
  readonly commit: Commit;
}

/** Up to the commit: repository checks, the pull request's merge commit, and the commit itself. */
async function resolve(transport: Transport, candidate: CandidateRecord, order: number, searched: ReadonlyMap<string, SearchRepository>): Promise<Resolved> {
  const license = await checkRepository(transport, candidate, searched);
  if (candidate.pull !== null) {
    const response = await transport.get(urls.pull(candidate.repo, candidate.pull));
    if (response.status !== 200) {
      throw new Drop("diff_fetched", "pr_unavailable", `the pull request returned ${String(response.status)}`);
    }
    const pull = schemas.pull.parse(response.body);
    if (!pull.merged || pull.merge_commit_sha === null) {
      throw new Drop("diff_fetched", "pr_not_merged", "the pull request was not merged");
    }
    candidate.commit = pull.merge_commit_sha;
  }
  const response = await transport.get(urls.commit(candidate.repo, candidate.commit ?? ""));
  if (response.status !== 200) {
    throw new Drop("diff_fetched", "commit_unavailable", `the commit returned ${String(response.status)}`);
  }
  const commit = schemas.commit.parse(response.body);
  candidate.committed_at = commit.commit.committer?.date ?? null;
  candidate.patch_id = patchId(commit.files);
  return { candidate, order, license, commit };
}

function commitTime(entry: Resolved): number {
  const time = Date.parse(entry.candidate.committed_at ?? "");
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/** Keeps the earliest commit of each SHA and then of each patch ID; earlier in harvest order breaks ties. */
function deduplicate(resolved: readonly Resolved[]): { kept: Resolved[]; dropped: [Resolved, Drop][] } {
  const ranked = [...resolved].sort((a, b) => commitTime(a) - commitTime(b) || a.order - b.order);
  const bySha = new Map<string, CandidateRecord>();
  const byPatch = new Map<string, CandidateRecord>();
  const kept: Resolved[] = [];
  const dropped: [Resolved, Drop][] = [];
  for (const entry of ranked) {
    const sha = entry.commit.sha;
    const patch = entry.candidate.patch_id;
    const sameCommit = bySha.get(sha);
    if (sameCommit !== undefined) {
      dropped.push([entry, new Drop("diff_fetched", "duplicate_commit", `commit ${sha} is already candidate ${sameCommit.id}`)]);
      continue;
    }
    bySha.set(sha, entry.candidate);
    const samePatch = patch === null ? undefined : byPatch.get(patch);
    if (samePatch !== undefined) {
      dropped.push([entry, new Drop("diff_fetched", "duplicate_patch", `the patch is the same as candidate ${samePatch.id}, committed no later`)]);
      continue;
    }
    if (patch !== null) {
      byPatch.set(patch, entry.candidate);
    }
    kept.push(entry);
  }
  return { kept: kept.sort((a, b) => a.order - b.order), dropped };
}

interface Blobs {
  readonly file: CommitFile;
  readonly before: { readonly text: string; readonly sha: string };
  readonly after: { readonly text: string; readonly sha: string };
}

async function fetchBlob(transport: Transport, repo: string, path: string, ref: string, side: string): Promise<{ text: string; sha: string }> {
  const response = await transport.get(urls.content(repo, path, ref));
  if (response.status !== 200) {
    throw new Drop("diff_fetched", "blob_unavailable", `the ${side} blob of ${path} returned ${String(response.status)}`);
  }
  const content: Content = schemas.content.parse(response.body);
  if (content.type !== "file" || content.encoding !== "base64" || content.content === undefined) {
    throw new Drop("diff_fetched", "blob_too_large", `the ${side} blob of ${path} (${String(content.size)} bytes) has no inline content`);
  }
  const bytes = Buffer.from(content.content, "base64");
  if (gitBlobSha1(bytes) !== content.sha) {
    throw new Drop("diff_fetched", "blob_mismatch", `the ${side} blob of ${path} does not hash to ${content.sha}`);
  }
  return { text: new TextDecoder("utf-8").decode(bytes), sha: content.sha };
}

/** After de-duplication: the commit's files and blobs, the source rule and the structural checks. */
async function examine(transport: Transport, { candidate, license, commit }: Resolved): Promise<void> {
  const sha = commit.sha;
  const [parent] = commit.parents;
  if (commit.parents.length !== 1 || parent === undefined) {
    throw new Drop("diff_fetched", "not_single_parent", `the commit has ${String(commit.parents.length)} parents`);
  }
  if (commit.files.length >= MAX_COMMIT_FILES) {
    throw new Drop("diff_fetched", "too_many_files", `the commit lists ${String(commit.files.length)} files, the most one page holds`);
  }
  const sources = commit.files.filter((file) => file.status === "modified" && SOURCE_FILE.test(file.filename));
  if (sources.length === 0) {
    throw new Drop("diff_fetched", "no_ts_js_change", "the commit modifies no TypeScript or JavaScript file");
  }
  const patched = sources.filter((file) => file.patch !== undefined);
  if (patched.length === 0) {
    throw new Drop("diff_fetched", "patch_missing", "GitHub gave no patch for any modified TypeScript or JavaScript file");
  }
  const timezoneFiles = patched.filter((file) => TIMEZONE_TEXT.test(addedText(file.patch ?? "")));
  if (timezoneFiles.length > MAX_TIMEZONE_FILES) {
    throw new Drop("diff_fetched", "too_many_files", `${String(timezoneFiles.length)} files add time-zone text, more than ${String(MAX_TIMEZONE_FILES)}`);
  }
  const blobs: Blobs[] = [];
  for (const file of timezoneFiles) {
    const before = await fetchBlob(transport, candidate.repo, file.filename, parent.sha, "parent");
    const after = await fetchBlob(transport, candidate.repo, file.filename, sha, "commit");
    if (after.sha !== file.sha) {
      throw new Drop("diff_fetched", "blob_mismatch", `the commit blob of ${file.filename} is ${after.sha}, the commit lists ${file.sha ?? "none"}`);
    }
    blobs.push({ file, before, after });
  }
  candidate.stage_reached = "diff_fetched";

  if (blobs.length === 0) {
    throw new Drop("source_rule_matched", "no_timezone_text_added", "no modified TypeScript or JavaScript file adds time-zone text");
  }
  for (const blob of blobs) {
    const added = addedLines(blob.file.patch ?? "");
    candidate.matches.push(...examineFile(blob.file.filename, blob.before.text, blob.after.text, added).map((match) => ({ ...match, path: blob.file.filename })));
  }
  if (candidate.matches.length === 0) {
    throw new Drop("source_rule_matched", "no_rule_match_on_added_line", "the candidate rule matches no call on an added line");
  }
  candidate.stage_reached = "source_rule_matched";

  for (const match of candidate.matches) {
    const blob = blobs.find((entry) => entry.file.filename === match.path);
    if (match.outcome.status === "confirmed" && blob !== undefined) {
      candidate.confirmation = {
        license,
        commit: sha,
        parent: parent.sha,
        path: match.path,
        before_blob: blob.before.sha,
        after_blob: blob.after.sha,
        line: match.line,
        call: match.call,
        callee: match.callee,
        function: match.function,
        before_line: match.outcome.before_line,
        before_call: match.outcome.before_call,
        timezone: match.outcome.timezone,
      };
      candidate.stage_reached = "structurally_confirmed";
      return;
    }
  }
  const rejection = candidate.matches.map((match) => match.outcome).find((outcome) => outcome.status === "rejected");
  if (rejection === undefined) {
    throw new Error("a matched candidate has neither a confirmation nor a rejection");
  }
  throw new Drop("structurally_confirmed", rejection.reason, rejection.detail);
}

function record(candidate: CandidateRecord, drop: Drop): void {
  candidate.drop = { stage: drop.stage, reason: drop.reason, detail: drop.message };
}

/** Runs a step for a candidate and records a drop; any other error stops the funnel. */
async function attempt<T>(candidate: CandidateRecord, step: () => Promise<T>): Promise<T | undefined> {
  try {
    return await step();
  } catch (error) {
    if (!(error instanceof Drop)) {
      throw error;
    }
    record(candidate, error);
    return undefined;
  }
}

export async function runFunnel(transport: Transport, options: { readonly max: number; readonly queries: readonly Query[] }): Promise<FunnelCore> {
  const harvested = await harvestCandidates(transport, options.queries, options.max);
  const resolved: Resolved[] = [];
  for (const [order, candidate] of harvested.candidates.entries()) {
    const entry = await attempt(candidate, () => resolve(transport, candidate, order, harvested.searched));
    if (entry !== undefined) {
      resolved.push(entry);
    }
  }
  const { kept, dropped } = deduplicate(resolved);
  for (const [entry, drop] of dropped) {
    record(entry.candidate, drop);
  }
  for (const entry of kept) {
    await attempt(entry.candidate, () => examine(transport, entry));
  }
  const stages = STAGES.map((stage, index) => {
    const drops: Record<string, number> = {};
    for (const candidate of harvested.candidates) {
      if (candidate.drop?.stage === stage) {
        drops[candidate.drop.reason] = (drops[candidate.drop.reason] ?? 0) + 1;
      }
    }
    const count = harvested.candidates.filter((candidate) => STAGES.indexOf(candidate.stage_reached) >= index).length;
    return { stage, count, drops };
  });
  const queries = harvested.queries.map((query, index) => {
    const own = harvested.candidates.filter((candidate) => candidate.query === index);
    return { ...query, stages: stageCounts(own), drops: rankDrops(own) };
  });
  return {
    schema_version: 2,
    shape_id: SHAPE_ID,
    source_rule: { ...SOURCE_RULE, sha256: createHash("sha256").update(candidateRuleBytes()).digest("hex") },
    queries,
    stages,
    candidates: harvested.candidates,
  };
}
