// The pinned Umami commit, the 24 spec files of its API suite, and the reader for the kit's list of
// closure files. Umami's files are never committed here: the kit stages them at the pinned commit,
// and `fetch-closure` downloads them for development, each checked against the kit's list.

export const UMAMI_REPOSITORY = "umami-software/umami";
export const UMAMI_COMMIT = "ec0ff50388c264ed8ce46f00967e92f7e71476ae";

/** The Playwright version the kit installs in the verifier's own node_modules (kit/umami/verifier/package.json). */
export const PLAYWRIGHT_VERSION = "1.63.0";

/** The 24 unchanged spec files of the original API suite. */
export const ORIGINAL_SPEC_FILES: readonly string[] = [
  "tests/api/account.spec.ts",
  "tests/api/admin.spec.ts",
  "tests/api/analytics.spec.ts",
  "tests/api/annotations.spec.ts",
  "tests/api/auth.spec.ts",
  "tests/api/boards.spec.ts",
  "tests/api/collection.spec.ts",
  "tests/api/event-data.spec.ts",
  "tests/api/links.spec.ts",
  "tests/api/mcp.spec.ts",
  "tests/api/pixels.spec.ts",
  "tests/api/replays.spec.ts",
  "tests/api/report-migration.spec.ts",
  "tests/api/reports.spec.ts",
  "tests/api/revenue.spec.ts",
  "tests/api/segments.spec.ts",
  "tests/api/session-data.spec.ts",
  "tests/api/sessions.spec.ts",
  "tests/api/shares.spec.ts",
  "tests/api/system.spec.ts",
  "tests/api/teams.spec.ts",
  "tests/api/two-factor.spec.ts",
  "tests/api/users.spec.ts",
  "tests/api/websites.spec.ts",
];

/** The one app module a spec imports (report-migration.spec.ts: '../../src/lib/analytics-query'). */
export const ANALYTICS_QUERY_PATH = "src/lib/analytics-query.ts";

const SUM_LINE = /^([0-9a-f]{64}) {2}([A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)$/;

/**
 * Reads the kit's closure list (`closure.sha256`, one `sha256sum` line per file): the pinned
 * Playwright API config, every file in tests/api except .runtime, and the analytics-query module,
 * by repository-relative path. The kit checks the same list when it stages the suite.
 */
export function parseClosureList(text: string): Record<string, string> {
  const closure: Record<string, string> = {};
  text
    .split("\n")
    .filter((line) => line !== "")
    .forEach((line, index) => {
      const match = SUM_LINE.exec(line);
      const hash = match?.[1];
      const path = match?.[2];
      if (hash === undefined || path === undefined || path in closure) {
        throw new Error(`closure list line ${String(index + 1)} is not a unique "<sha256>  <relative path>" line`);
      }
      closure[path] = hash;
    });
  return closure;
}

/** The required closure files a list leaves out: every original spec file and the analytics-query module. */
export function closureListProblems(closure: Readonly<Record<string, string>>, specFiles: readonly string[] = ORIGINAL_SPEC_FILES): string[] {
  return [...specFiles, ANALYTICS_QUERY_PATH].filter((path) => !(path in closure)).sort();
}
