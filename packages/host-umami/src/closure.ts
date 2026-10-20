// The original suite's closure: the files the kit copies into its protected verifier area and the
// suite runs from there (kit/umami/closure.sha256), never from the app copy. A change to one of
// them in the app copy is invisible to the original suite, so a planted change or a copy plan
// may never touch them. Every file under tests/ is left out as well, so the original suite stays unchanged.

/** The one app module a spec imports from the pristine copy (report-migration.spec.ts). */
export const CLOSURE_APP_MODULE = "src/lib/analytics-query.ts";

const CLOSURE_FILES: readonly string[] = ["playwright.api.config.ts", CLOSURE_APP_MODULE];
const CLOSURE_PREFIXES: readonly string[] = ["tests/"];

export function isClosurePath(path: string): boolean {
  return CLOSURE_FILES.includes(path) || CLOSURE_PREFIXES.some((prefix) => path.startsWith(prefix));
}
