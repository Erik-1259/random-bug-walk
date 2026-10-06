// A synthetic GitHub REST API for tests: a fetch implementation that serves fixed responses by
// path and query. Every repository, commit and file is synthetic. Raw responses carry fields the
// harvest must not freeze (commit authors and emails, owner records), so tests can check that the
// frozen bodies drop them.
import { createHash } from "node:crypto";
import { searchUrl, type Query } from "../../src/queries.ts";

export const SYNTHETIC_QUERIES: readonly Query[] = [
  { kind: "commits", api: "syntheticRange", q: "syntheticRange timezone fix" },
  { kind: "pulls", api: "syntheticFailing", q: "is:pr is:merged syntheticFailing timezone" },
  { kind: "pulls", api: "syntheticFormat", q: "is:pr is:merged syntheticFormat timezone" },
];

const ORG = "synthetic-org";
const PERSON = { name: "Synthetic Person", email: "synthetic-person@example.invalid", login: "synthetic-person" };

type Json = Record<string, unknown>;

interface Route {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function gitBlob(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1").update(`blob ${String(bytes.length)}\0`).update(bytes).digest("hex");
}

function sha(label: string): string {
  return createHash("sha1").update(`synthetic-commit:${label}`).digest("hex");
}

/** A unified-diff hunk that replaces the lines of `before` with `after`, as GitHub's `patch` field. */
function patchOf(before: string, after: string): string {
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

interface FileChange {
  path: string;
  before: string;
  after: string;
  /** Overrides for the commit's file entry or its content responses. */
  noPatch?: boolean;
  beforeStatus?: number;
  afterEncoding?: string;
  afterSha?: string;
}

interface Scenario {
  name: string;
  /** The licence's SPDX identifier, or null for a repository with none. */
  licence?: string | null;
  /** Where the licence shows: the search result, the repository record (the default), or only the licence endpoint. */
  licenceIn?: "search" | "repository" | "licence_endpoint";
  /** The search result's fork flag (default false); "absent" leaves the flag out of the search result. */
  fork?: boolean | "absent";
  repoStatus?: number;
  /** The scenario whose commit this repository also holds, under the same SHA. */
  sameCommitAs?: string;
  committedAt?: string;
  commitStatus?: number;
  parents?: number;
  files?: FileChange[];
  extraFiles?: Json[];
  /** False for a commit reached only through a pull request. */
  searched?: boolean;
}

const HOOK_BEFORE = `import { useDateRange } from "./hooks";

export function RangePage() {
  const range = useDateRange();
  return range;
}
`;
const HOOK_AFTER = `import { useDateRange, useTimezone } from "./hooks";

export function RangePage() {
  const { timezone } = useTimezone();
  const range = useDateRange({ timezone });
  return range;
}
`;

const SQL_BEFORE = `export function statsQuery(siteId: string, filters: { unit: string; timezone: string }) {
  const { unit } = filters;
  return getDateSQL("created_at", unit);
}
`;
const SQL_AFTER = `export function statsQuery(siteId: string, filters: { unit: string; timezone: string }) {
  const { unit } = filters;
  return getDateSQL("created_at", unit, filters.timezone);
}
`;

function simple(path: string, before: string, after: string): FileChange[] {
  return [{ path, before, after }];
}

const LABEL = `export function label(d: Date, timezone: string) {
  return formatDate(d);
}
`;

const HOOK_FILES: FileChange[] = [{ path: "src/pages/RangePage.tsx", before: HOOK_BEFORE, after: HOOK_AFTER }];

const SCENARIOS: Scenario[] = [
  // The same change as "hook" in another repository, found first but committed later: a duplicate patch.
  { name: "copy", licence: "MIT", committedAt: "2026-05-01T00:00:00Z", files: HOOK_FILES },
  { name: "hook", licence: "MIT", committedAt: "2026-03-01T00:00:00Z", files: HOOK_FILES },
  { name: "repo-gone", repoStatus: 404, fork: "absent" },
  { name: "forked", licence: "MIT", fork: true, files: HOOK_FILES },
  { name: "no-licence", licence: null },
  { name: "other-licence", licence: "NOASSERTION" },
  { name: "copyleft", licence: "GPL-3.0" },
  { name: "commit-gone", licence: "MIT", commitStatus: 422 },
  { name: "merge", licence: "MIT", parents: 2, files: simple("src/merge.ts", LABEL, LABEL.replace("formatDate(d)", "formatDate(d, timezone)")) },
  {
    name: "wide",
    licence: "ISC",
    files: Array.from({ length: 11 }, (_unused, index) => ({
      path: `src/wide-${String(index)}.ts`,
      before: LABEL,
      after: LABEL.replace("formatDate(d)", "formatDate(d, timezone)"),
    })),
  },
  {
    name: "docs-only",
    licence: "MIT",
    extraFiles: [{ filename: "README.md", status: "modified", sha: gitBlob("synthetic readme\n"), patch: "@@ -1 +1 @@\n-a\n+timezone" }],
  },
  { name: "no-patch", licence: "MIT", files: [{ path: "src/big.ts", before: LABEL, after: `${LABEL}\n`, noPatch: true }] },
  { name: "parent-gone", licence: "MIT", files: [{ path: "src/parent.ts", before: LABEL, after: LABEL.replace("formatDate(d)", "formatDate(d, timezone)"), beforeStatus: 404 }] },
  { name: "huge-blob", licence: "MIT", files: [{ path: "src/huge.ts", before: LABEL, after: LABEL.replace("formatDate(d)", "formatDate(d, timezone)"), afterEncoding: "none" }] },
  {
    name: "blob-drift",
    licence: "MIT",
    files: [{ path: "src/drift.ts", before: LABEL, after: LABEL.replace("formatDate(d)", "formatDate(d, timezone)"), afterSha: gitBlob("synthetic other\n") }],
  },
  { name: "no-tz-text", licence: "MIT", files: simple("src/a.ts", LABEL, LABEL.replace("formatDate(d)", "formatDate(d, 'yyyy')")) },
  { name: "comment-only", licence: "MIT", files: simple("src/a.ts", LABEL, LABEL.replace("  return", "  // The timezone is handled later.\n  return")) },
  {
    name: "new-function",
    licence: "BSD-3-Clause",
    files: simple("src/a.ts", LABEL, `${LABEL}\nexport function zoned(d: Date, timezone: string) {\n  return formatDate(d, timezone);\n}\n`),
  },
  {
    name: "new-call",
    licence: "MIT",
    files: simple("src/a.ts", LABEL, LABEL.replace("  return formatDate(d);", "  const shown = formatDate(d, timezone);\n  return formatDate(d) + shown;")),
  },
  {
    name: "already-passed",
    licence: "MIT",
    files: simple(
      "src/a.ts",
      `export function label(d: Date, timezone: string) {\n  return formatInTimeZone(d, timezone, "yyyy");\n}\n`,
      `export function label(d: Date, timezone: string) {\n  return formatInTimeZone(d, timezone, "yyyy-MM");\n}\n`,
    ),
  },
  {
    name: "constant-zone",
    licence: "MIT",
    files: simple(
      "src/a.js",
      `export function label(d) {\n  return d.toLocaleDateString("en");\n}\n`,
      `export function label(d) {\n  return d.toLocaleDateString("en", { timeZone: "UTC" });\n}\n`,
    ),
  },
  {
    name: "global-zone",
    licence: "MIT",
    files: simple("src/a.ts", `export function label(d: Date) {\n  return formatDate(d);\n}\n`, `export function label(d: Date) {\n  return formatDate(d, timezone);\n}\n`),
  },
  { name: "sql", licence: "Apache-2.0", licenceIn: "licence_endpoint", searched: false, files: simple("src/queries/stats.ts", SQL_BEFORE, SQL_AFTER) },
  // The merge commit of pull request 7, also pushed to an unrelated repository under the same SHA.
  { name: "mirror", licence: "MIT", sameCommitAs: "sql", files: simple("src/queries/stats.ts", SQL_BEFORE, SQL_AFTER) },
  {
    name: "search-licence",
    licence: "ISC",
    licenceIn: "search",
    files: simple("src/label.ts", LABEL, LABEL.replace("formatDate(d)", "formatDate(d, timezone)")),
  },
  // The last commit result, which the round-robin reaches last and the cap leaves out.
  { name: "beyond-max", licence: "MIT" },
];

interface PullScenario {
  repo: string;
  number: number;
  status?: number;
  merged?: boolean;
  /** The scenario whose commit the pull request merged as. */
  commit?: string;
}

const PULLS: PullScenario[] = [
  { repo: "synthetic-sql", number: 7, merged: true, commit: "sql" },
  { repo: "synthetic-pull-gone", number: 8, status: 404 },
  { repo: "synthetic-open", number: 9, merged: false },
  { repo: "synthetic-hook", number: 10, merged: true, commit: "hook" },
];

/** Every search result but the last commit, "beyond-max". */
export const SYNTHETIC_MAX = SCENARIOS.filter((scenario) => scenario.searched !== false).length + PULLS.length - 1;

function repoName(scenario: string): string {
  return `synthetic-${scenario}`;
}

function licenceBody(licence: Scenario["licence"]): Json | null {
  return licence === undefined || licence === null ? null : { key: licence.toLowerCase(), spdx_id: licence, name: licence };
}

function repoBody(name: string, licence: Scenario["licence"], fork = false): Json {
  const owner = { login: ORG, id: 1, type: "Organization" };
  return { id: 1, full_name: `${ORG}/${name}`, private: false, fork, owner, license: licenceBody(licence), language: "TypeScript", stargazers_count: 3 };
}

function contentBody(path: string, text: string, encoding = "base64", blob?: string): Json {
  return {
    type: "file",
    path,
    size: Buffer.byteLength(text),
    sha: blob ?? gitBlob(text),
    encoding,
    content: encoding === "base64" ? Buffer.from(text, "utf8").toString("base64") : "",
  };
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function buildRoutes(): Map<string, Route> {
  const routes = new Map<string, Route>();
  const add = (url: string, status: number, body: unknown): void => {
    routes.set(url, { status, body });
  };
  const commitItems: Json[] = [];
  for (const scenario of SCENARIOS) {
    const name = repoName(scenario.name);
    const full = `${ORG}/${name}`;
    const source = scenario.sameCommitAs ?? scenario.name;
    const commit = sha(source);
    const parent = sha(`${source}:parent`);
    const licenceIn = scenario.licenceIn ?? "repository";
    const fork = scenario.fork ?? false;
    const licence = licenceBody(scenario.licence);
    if (scenario.searched !== false) {
      const repository: Json = {
        full_name: full,
        owner: { login: ORG },
        ...(fork === "absent" ? {} : { fork }),
        ...(licenceIn === "search" ? { license: licence } : {}),
      };
      commitItems.push({ sha: commit, repository, commit: { message: "synthetic fix", author: PERSON } });
    }
    add(
      `/repos/${full}`,
      scenario.repoStatus ?? 200,
      scenario.repoStatus === undefined ? repoBody(name, licenceIn === "licence_endpoint" ? null : scenario.licence, fork === true) : { message: "Not Found" },
    );
    add(
      `/repos/${full}/license`,
      scenario.repoStatus === undefined && licence !== null ? 200 : 404,
      scenario.repoStatus === undefined && licence !== null
        ? { name: "LICENSE", path: "LICENSE", content: Buffer.from("synthetic licence text\n").toString("base64"), license: licence }
        : { message: "Not Found" },
    );
    const files: Json[] = (scenario.files ?? []).map((file) => {
      const afterBlob = file.afterSha ?? gitBlob(file.after);
      const before = `/repos/${full}/contents/${encodePath(file.path)}?ref=${parent}`;
      const after = `/repos/${full}/contents/${encodePath(file.path)}?ref=${commit}`;
      add(before, file.beforeStatus ?? 200, file.beforeStatus === undefined ? contentBody(file.path, file.before) : { message: "Not Found" });
      add(after, 200, contentBody(file.path, file.after, file.afterEncoding, file.afterEncoding === undefined ? undefined : afterBlob));
      return {
        filename: file.path,
        status: "modified",
        sha: afterBlob,
        additions: 1,
        deletions: 1,
        ...(file.noPatch === true ? {} : { patch: patchOf(file.before, file.after) }),
      };
    });
    const parents = Array.from({ length: scenario.parents ?? 1 }, (_unused, index) => ({ sha: index === 0 ? parent : sha(`${source}:p${String(index)}`) }));
    const committer = { ...PERSON, date: scenario.committedAt ?? "2026-04-01T00:00:00Z" };
    add(
      `/repos/${full}/commits/${commit}`,
      scenario.commitStatus ?? 200,
      scenario.commitStatus === undefined
        ? { sha: commit, parents, commit: { message: "synthetic fix", author: PERSON, committer }, author: PERSON, committer: PERSON, files: [...files, ...(scenario.extraFiles ?? [])] }
        : { message: "No commit found" },
    );
  }
  const pullItems: Json[] = [];
  for (const pull of PULLS) {
    const full = `${ORG}/${pull.repo}`;
    pullItems.push({ number: pull.number, repository_url: `https://api.github.com/repos/${full}`, pull_request: { url: "synthetic" }, user: PERSON });
    if (!routes.has(`/repos/${full}`)) {
      add(`/repos/${full}`, 200, repoBody(pull.repo, "MIT"));
    }
    add(
      `/repos/${full}/pulls/${String(pull.number)}`,
      pull.status ?? 200,
      pull.status === undefined
        ? { number: pull.number, merged: pull.merged === true, merge_commit_sha: pull.commit === undefined ? null : sha(pull.commit), user: PERSON }
        : { message: "Not Found" },
    );
  }
  const search = searchUrl;
  const [commits, failing, pulls] = SYNTHETIC_QUERIES;
  if (commits === undefined || failing === undefined || pulls === undefined) {
    throw new Error("synthetic queries are missing");
  }
  // A repeated hit early in the results, so the round-robin meets it before the cap.
  add(search(commits), 200, { total_count: commitItems.length, incomplete_results: false, items: [...commitItems.slice(0, 2), commitItems[0], ...commitItems.slice(2)] });
  add(search(failing), 422, { message: "Validation Failed" });
  add(search(pulls), 200, { total_count: pullItems.length, incomplete_results: false, items: pullItems });
  return routes;
}

export interface SyntheticGitHub {
  readonly fetch: typeof fetch;
  /** Every request URL served, in order, with its authorization header if any. */
  readonly requests: { url: string; authorization: string | null }[];
}

export function syntheticGitHub(): SyntheticGitHub {
  const routes = buildRoutes();
  const requests: SyntheticGitHub["requests"] = [];
  const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    const key = `${url.pathname}${url.search}`;
    requests.push({ url: key, authorization: headers.get("authorization") });
    const route = routes.get(key);
    const status = route?.status ?? 404;
    const body = route === undefined ? { message: `synthetic: no route for ${key}` } : route.body;
    const resource = url.pathname.startsWith("/search/") ? "search" : "core";
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": "1790000000",
          "x-ratelimit-resource": resource,
          ...route?.headers,
        },
      }),
    );
  };
  return { fetch: fake, requests };
}

export const SYNTHETIC_START = Date.parse("2026-10-01T00:00:00.000Z");

/** A clock that advances one second per reading, so frozen times are fixed. */
export function steppingClock(start = SYNTHETIC_START): { now: () => number; date: () => Date } {
  let tick = start;
  const now = (): number => {
    const value = tick;
    tick += 1000;
    return value;
  };
  return { now, date: () => new Date(now()) };
}
