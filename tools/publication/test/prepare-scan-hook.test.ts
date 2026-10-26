import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ScanHook } from "@rbw/case-package";
import { describe, expect, it } from "vitest";
import { GITLEAKS_COMMAND_VARIABLE, PATTERN_FILE_VARIABLE, SCAN_HOOK, scanPreparedPart } from "../src/prepare-scan-hook.ts";
import { cleanEnv, forms, packageDir, readJsonLines, run, STUB_LEAK_MARKER, tempDir, writePatterns, writeStubGitleaks } from "./support.ts";

// The hook must fit case-package's contract as it is, so prepare can load it by path.
const hookContract: ScanHook = SCAN_HOOK;

const TERM = "synthetic-hook-term";
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function settings(): { root: string; env: Record<string, string>; callsLog: string } {
  const root = tempDir("rbw-prepare-scan-test-");
  const patterns = writePatterns(root, `# synthetic pattern list\n${TERM}\n`);
  const stub = writeStubGitleaks(root);
  return { root, env: { [PATTERN_FILE_VARIABLE]: patterns, [GITLEAKS_COMMAND_VARIABLE]: stub.command }, callsLog: stub.callsLog };
}

function part(files: Record<string, string>): { part: string; members: { path: string; bytes: Uint8Array }[] } {
  return { part: "bug_case", members: Object.entries(files).map(([path, text]) => ({ path, bytes: encode(text) })) };
}

const CLEAN_FILES = {
  "manifest.json": '{ "format": "synthetic" }\n',
  "src/app.js": "export const total = 1;\n",
  "notes/readme.md": "# Notes\n\nNothing to report.\n",
};

describe("prepare scan hook", () => {
  it("answers clean for a part with no pattern term, attribution form or secret", async () => {
    const { env } = settings();
    expect(await scanPreparedPart(part(CLEAN_FILES), env)).toEqual({ outcome: "clean" });
  });

  it("blocks a planted synthetic term and a stand-in secret, with member locations and never the matched text", async () => {
    const { env } = settings();
    // The term also sits in manifest.json, the first member, so a hook that leaves the first member out of the scan fails.
    const files = {
      "manifest.json": `{ "format": "synthetic",\n  "note": "${TERM}" }\n`,
      "src/app.js": `export const total = 1;\n// ${TERM}\n`,
      "notes/readme.md": `# Notes\n\nkey ${STUB_LEAK_MARKER}\n`,
    };
    const verdict = await scanPreparedPart(part(files), env);
    expect(verdict).toEqual({ outcome: "blocked", locations: ["manifest.json:2", "notes/readme.md:3", "src/app.js:2"] });
    expect(JSON.stringify(verdict)).not.toContain(TERM);
    expect(JSON.stringify(verdict)).not.toContain(STUB_LEAK_MARKER);
  });

  it("blocks an attribution form in a member, the check the names-attribution job also runs", async () => {
    const { env } = settings();
    const verdict = await scanPreparedPart(part({ ...CLEAN_FILES, "src/app.js": `export const total = 1;\n// ${forms.generatedBy} a tool\n` }), env);
    expect(verdict).toEqual({ outcome: "blocked", locations: ["src/app.js:2"] });
  });

  it("answers unavailable when the pattern file is missing, either setting is unset or empty, or the part is malformed", async () => {
    const { root, env } = settings();
    const clean = part(CLEAN_FILES);
    const without = (name: string): Record<string, string> => Object.fromEntries(Object.entries(env).filter(([key]) => key !== name));
    const unavailable = { outcome: "unavailable" };
    expect(await scanPreparedPart(clean, { ...env, [PATTERN_FILE_VARIABLE]: join(root, "no-such-patterns.txt") })).toEqual(unavailable);
    expect(await scanPreparedPart(clean, without(PATTERN_FILE_VARIABLE))).toEqual(unavailable);
    expect(await scanPreparedPart(clean, without(GITLEAKS_COMMAND_VARIABLE))).toEqual(unavailable);
    expect(await scanPreparedPart(clean, { ...env, [PATTERN_FILE_VARIABLE]: "" })).toEqual(unavailable);
    expect(await scanPreparedPart(clean, { ...env, [GITLEAKS_COMMAND_VARIABLE]: " " })).toEqual(unavailable);
    expect(await scanPreparedPart(clean, { ...env, [GITLEAKS_COMMAND_VARIABLE]: join(root, "no-such-gitleaks") })).toEqual(unavailable);
    expect(await scanPreparedPart(part({ "../outside.txt": "x\n" }), env)).toEqual(unavailable);
    expect(await scanPreparedPart(part({ "a/b.txt": "x\n", "a/b.txt/c.txt": "y\n" }), env)).toEqual(unavailable);
    expect(await scanPreparedPart({ part: "bug_case", members: [] }, env)).toEqual(unavailable);
    expect(await scanPreparedPart({ part: "bug_case", members: [{ path: "a.txt", bytes: "text" }] }, env)).toEqual(unavailable);
    expect(await scanPreparedPart(null, env)).toEqual(unavailable);
    expect(await hookContract({ part: "validator", members: [] })).toEqual(unavailable);
  });
});

/** case-package's own command line, found through its package entry. */
const prepareCli = join(dirname(createRequire(import.meta.url).resolve("@rbw/case-package")), "cli.ts");
const hookModule = join(packageDir, "src", "prepare-scan-hook.ts");
const registryModule = join(packageDir, "test", "fixtures", "synthetic-registry.ts");

async function prepare(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string; out: string; scratch: string }> {
  const root = tempDir("rbw-prepare-scan-e2e-");
  const out = join(root, "prepared");
  const scratch = join(root, "tmp");
  mkdirSync(scratch);
  const args = [prepareCli, "prepare", "--registry", registryModule, "--identity", registryModule, "--scan-hook", hookModule, "--out", out];
  const result = await run(process.execPath, args, { env: cleanEnv({ ...env, SYNTHETIC_PREPARE_WORKDIR: join(root, "inputs"), TMPDIR: scratch }) });
  return { ...result, out, scratch };
}

describe("case-package prepare --scan-hook with the prepare scan hook", () => {
  it("scans both parts of the synthetic host and writes index entries with scanned: true", async () => {
    const { env, callsLog } = settings();
    const result = await prepare(env);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("(not scanned)");
    const index = JSON.parse(readFileSync(join(result.out, "index.json"), "utf8")) as { entries: { entry_id: string; scanned: boolean }[] };
    expect(index.entries.map((entry) => [entry.entry_id, entry.scanned])).toEqual([["synthetic-task-report-01", true]]);
    // One gitleaks scan for each part, and the members' temporary directories are gone.
    expect(readJsonLines(callsLog).filter((args) => Array.isArray(args) && args.includes("dir"))).toHaveLength(2);
    expect(readdirSync(result.scratch)).toEqual([]);
  });

  it("refuses and writes nothing when a member holds a pattern term, printing locations and never the term", async () => {
    const { root, env } = settings();
    const patterns = writePatterns(join(root, "app-term"), "countAcknowledged\n");
    const result = await prepare({ ...env, [PATTERN_FILE_VARIABLE]: patterns });
    expect(result.code).toBe(1);
    const locations = ["source/src/counter.js:2", "source/test/counter.test.js:2", "source/test/counter.test.js:5", "source/test/counter.test.js:6", "source/test/counter.test.js:7"];
    expect(result.stderr).toBe(`export refused (scan_blocked): ${locations.map((location) => `bug_case: ${location}`).join("; ")}\n`);
    expect(result.stderr.toLowerCase()).not.toContain("countacknowledged");
    expect(result.stdout).toBe("");
    expect(existsSync(result.out)).toBe(false);
  });

  it("refuses as unavailable when the pattern file setting is missing", async () => {
    const { env } = settings();
    const result = await prepare({ [GITLEAKS_COMMAND_VARIABLE]: env[GITLEAKS_COMMAND_VARIABLE] ?? "" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("export refused (scan_unavailable)");
    expect(existsSync(result.out)).toBe(false);
  });
});
