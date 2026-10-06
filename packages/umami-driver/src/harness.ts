// Verifier-owned files written next to the pristine closure in every suite copy. They are hashed
// separately from the pristine files, and their hashes are part of the frozen manifest.
import { sha256Hex } from "@rbw/schema";

export const WRAPPER_CONFIG_NAME = "rbw-api.config.ts";
export const MARKER_NAME = "package.json";

/**
 * The trusted wrapper config: imports the pinned config and adds only Playwright's JSON reporter,
 * which writes to the path in PLAYWRIGHT_JSON_OUTPUT_FILE. The upstream reporters stay, so the
 * coverage reporter still runs; with API_COVERAGE=report its output is diagnostic only.
 */
export const WRAPPER_CONFIG_SOURCE = `// Trusted wrapper: the pinned Umami API config, unchanged, plus Playwright's JSON reporter.
// The report path comes from PLAYWRIGHT_JSON_OUTPUT_FILE, which the driver sets for each trial.
import config from './playwright.api.config.ts';

export default { ...config, reporter: [...config.reporter, ['json']] };
`;

/**
 * The harness files of a suite copy: the wrapper config, and the kit's verifier package.json,
 * whose "type": "module" the suite's ESM sources need, as Umami's own package.json provides.
 */
export function harnessFiles(marker: Uint8Array): Record<string, Uint8Array> {
  return { [MARKER_NAME]: marker, [WRAPPER_CONFIG_NAME]: Buffer.from(WRAPPER_CONFIG_SOURCE) };
}

export function harnessHashes(marker: Uint8Array): Record<string, string> {
  return Object.fromEntries(Object.entries(harnessFiles(marker)).map(([name, bytes]) => [name, sha256Hex(bytes)]));
}
