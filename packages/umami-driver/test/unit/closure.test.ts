import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@rbw/schema";
import {
  checkSuiteIsolation,
  closureIntegrity,
  hashFiles,
  prepareSuiteCopy,
  probeAnalyticsQuery,
  resolveRelativeImport,
} from "../../src/closure.ts";
import { WRAPPER_CONFIG_SOURCE, harnessFiles, harnessHashes } from "../../src/harness.ts";
import { ORIGINAL_SPEC_FILES, closureListProblems, parseClosureList } from "../../src/pinned.ts";
import { tempDir } from "../helpers.ts";

const SPEC_SOURCE = "import { serializeAnalyticsQuery } from '../../src/lib/analytics-query';\nexport { serializeAnalyticsQuery };\n";
const VERIFIER_QUERY = "export const origin = 'synthetic verifier copy';\n";
const MARKER = Buffer.from('{"private":true,"type":"module"}\n');
const HARNESS = harnessFiles(MARKER);
const KIT_CLOSURE = parseClosureList(readFileSync(new URL("../../../../kit/umami/closure.sha256", import.meta.url), "utf8"));
const sha = (text: string): string => sha256Hex(Buffer.from(text));

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A verifier root with a synthetic closure and node_modules, and a separate app copy. */
function layout() {
  const root = tempDir();
  const verifier = join(root, "verifier");
  const closureDir = join(verifier, "suite");
  const nodeModules = join(verifier, "node_modules");
  const app = join(root, "app");
  const files: Record<string, string> = {
    "playwright.api.config.ts": "export default { testDir: './tests/api' };\n",
    "tests/api/report-migration.spec.ts": SPEC_SOURCE,
    "tests/api/alpha.spec.ts": "export const alpha = 1;\n",
    "src/lib/analytics-query.ts": VERIFIER_QUERY,
  };
  for (const [path, content] of Object.entries(files)) write(closureDir, path, content);
  mkdirSync(join(nodeModules, "@playwright", "test"), { recursive: true });
  write(app, "src/lib/analytics-query.ts", "export const origin = 'synthetic app copy';\n");
  mkdirSync(join(app, "node_modules"), { recursive: true });
  const closure = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, sha(content)]));
  const suiteDir = join(root, "results", "trial", "work", "suite");
  return { root, closureDir, nodeModules, app, closure, suiteDir };
}

describe("pinned closure", () => {
  it("reads the kit's closure list: the 24 original spec files and the analytics-query module at its pinned hash", () => {
    expect(ORIGINAL_SPEC_FILES).toHaveLength(24);
    for (const spec of ORIGINAL_SPEC_FILES) expect(KIT_CLOSURE[spec]).toMatch(/^[0-9a-f]{64}$/);
    expect(KIT_CLOSURE["src/lib/analytics-query.ts"]).toBe("db91d1687058280bceeb565567dc77aa6c6284653732fdc47289a6cd23177655");
    expect(KIT_CLOSURE["playwright.api.config.ts"]).toBe("dac5cbca4e3f8a0e99f0aedf6c175dcf3d4db9974fe2e0282c3644e521759ca0");
    expect(Object.keys(KIT_CLOSURE).some((path) => path.includes(".runtime"))).toBe(false);
    expect(closureListProblems(KIT_CLOSURE)).toEqual([]);
  });

  it("refuses a closure list without a spec file or without the analytics-query module", () => {
    const dropped = new Set(["tests/api/users.spec.ts", "src/lib/analytics-query.ts"]);
    const rest = Object.fromEntries(Object.entries(KIT_CLOSURE).filter(([path]) => !dropped.has(path)));
    expect(closureListProblems(rest)).toEqual(["src/lib/analytics-query.ts", "tests/api/users.spec.ts"]);
  });

  it("refuses a malformed closure list line", () => {
    expect(() => parseClosureList("not-a-hash  tests/api/users.spec.ts\n")).toThrow(/line 1/);
    expect(() => parseClosureList(`${"a".repeat(64)}  /etc/passwd\n`)).toThrow(/line 1/);
  });

  it("keeps the wrapper config and the verifier's module marker apart from the pristine files, hashed separately", () => {
    expect(Object.keys(HARNESS).sort()).toEqual(["package.json", "rbw-api.config.ts"]);
    expect(KIT_CLOSURE["rbw-api.config.ts"]).toBeUndefined();
    expect(harnessHashes(MARKER)).toEqual({ "package.json": sha256Hex(MARKER), "rbw-api.config.ts": sha(WRAPPER_CONFIG_SOURCE) });
    expect(WRAPPER_CONFIG_SOURCE).toContain("./playwright.api.config.ts");
    expect(WRAPPER_CONFIG_SOURCE).toContain("'json'");
  });
});

describe("resolving the suite's analytics-query import", () => {
  it("resolves ../../src/lib/analytics-query to the per-trial copy, whose hash equals the closure's", async () => {
    const { closureDir, nodeModules, closure, suiteDir } = layout();
    await prepareSuiteCopy({ closureDir, suiteDir, verifierNodeModules: nodeModules, closurePaths: Object.keys(closure), harness: HARNESS });
    const resolved = resolveRelativeImport(join(suiteDir, "tests/api/report-migration.spec.ts"), "../../src/lib/analytics-query");
    expect(resolved).toBe(join(suiteDir, "src/lib/analytics-query.ts"));
    expect(sha256Hex(readFileSync(resolved ?? ""))).toBe(closure["src/lib/analytics-query.ts"]);
    expect(probeAnalyticsQuery(suiteDir)).toEqual({
      specifier: "../../src/lib/analytics-query",
      from: "tests/api/report-migration.spec.ts",
      resolved: "src/lib/analytics-query.ts",
      sha256: closure["src/lib/analytics-query.ts"],
    });
  });

  it("is unaffected by a changed file at the app path", async () => {
    const { closureDir, nodeModules, closure, suiteDir, app } = layout();
    await prepareSuiteCopy({ closureDir, suiteDir, verifierNodeModules: nodeModules, closurePaths: Object.keys(closure), harness: HARNESS });
    const before = probeAnalyticsQuery(suiteDir);
    writeFileSync(join(app, "src/lib/analytics-query.ts"), "export const origin = 'synthetic patched app copy';\n");
    expect(probeAnalyticsQuery(suiteDir)).toEqual(before);
    expect(before.sha256).toBe(sha(VERIFIER_QUERY));
  });

  it("reports an unresolved import when the per-trial copy lacks the module, instead of looking elsewhere", async () => {
    const { closureDir, nodeModules, closure, suiteDir } = layout();
    await prepareSuiteCopy({ closureDir, suiteDir, verifierNodeModules: nodeModules, closurePaths: Object.keys(closure), harness: HARNESS });
    rmSync(join(suiteDir, "src/lib/analytics-query.ts"));
    expect(probeAnalyticsQuery(suiteDir)).toMatchObject({ resolved: null, sha256: null });
  });

  it("follows Playwright's extension lookup order", () => {
    const root = tempDir();
    write(root, "lib/a.ts", "");
    write(root, "lib/a.js", "");
    write(root, "lib/b.ts", "");
    write(root, "lib/c/index.ts", "");
    const from = join(root, "spec.ts");
    expect(resolveRelativeImport(from, "./lib/a")).toBe(join(root, "lib/a.js"));
    expect(resolveRelativeImport(from, "./lib/b.js")).toBe(join(root, "lib/b.ts"));
    expect(resolveRelativeImport(from, "./lib/c")).toBe(join(root, "lib/c/index.ts"));
    expect(resolveRelativeImport(from, "./lib/none")).toBeNull();
    expect(() => resolveRelativeImport(from, "otplib")).toThrow(/relative/);
  });
});

describe("per-trial suite copy", () => {
  it("copies only the listed closure files, adds the harness files and links the verifier node_modules", async () => {
    const { closureDir, nodeModules, closure, suiteDir } = layout();
    write(closureDir, "tests/api/unlisted.spec.ts", "export {};\n");
    await prepareSuiteCopy({ closureDir, suiteDir, verifierNodeModules: nodeModules, closurePaths: Object.keys(closure), harness: HARNESS });
    const integrity = await closureIntegrity(suiteDir, closure, HARNESS);
    expect(integrity).toEqual({ changed: [], missing: [], extra: [], harness_changed: [] });
    expect(readFileSync(join(suiteDir, "rbw-api.config.ts"), "utf8")).toBe(WRAPPER_CONFIG_SOURCE);
    expect(readFileSync(join(suiteDir, "package.json")).equals(MARKER)).toBe(true);
  });

  it("finds a deleted spec, a changed byte and an added file, and ignores the runtime directories", async () => {
    const { closureDir, nodeModules, closure, suiteDir } = layout();
    rmSync(join(closureDir, "tests/api/alpha.spec.ts"));
    await prepareSuiteCopy({ closureDir, suiteDir, verifierNodeModules: nodeModules, closurePaths: Object.keys(closure), harness: HARNESS });
    writeFileSync(join(suiteDir, "src/lib/analytics-query.ts"), `${VERIFIER_QUERY} `);
    write(suiteDir, "tests/api/added.spec.ts", "export {};\n");
    write(suiteDir, "tests/api/.runtime/127.0.0.1-3000/seed.json", "{}");
    write(suiteDir, "test-results/api/output.txt", "x");
    writeFileSync(join(suiteDir, "rbw-api.config.ts"), "export default {};\n");
    writeFileSync(join(suiteDir, "package.json"), '{"type":"commonjs"}');
    expect(await closureIntegrity(suiteDir, closure, HARNESS)).toEqual({
      changed: ["src/lib/analytics-query.ts"],
      missing: ["tests/api/alpha.spec.ts"],
      extra: ["tests/api/added.spec.ts"],
      harness_changed: ["package.json", "rbw-api.config.ts"],
    });
  });

  it("hashes listed files and reports the ones that are absent", async () => {
    const { closureDir, closure } = layout();
    const result = await hashFiles(closureDir, [...Object.keys(closure), "tests/api/absent.spec.ts"]);
    expect(result.hashes).toEqual(closure);
    expect(result.missing).toEqual(["tests/api/absent.spec.ts"]);
  });
});

describe("suite isolation from the app copy", () => {
  it("passes for a per-trial copy outside the app whose node_modules is the verifier's", async () => {
    const { closureDir, nodeModules, closure, suiteDir, app } = layout();
    await prepareSuiteCopy({ closureDir, suiteDir, verifierNodeModules: nodeModules, closurePaths: Object.keys(closure), harness: HARNESS });
    expect(checkSuiteIsolation({ suiteDir, appDir: app, verifierNodeModules: nodeModules })).toEqual([]);
  });

  it("fails for a copy inside the app directory", async () => {
    const { closureDir, nodeModules, closure, app } = layout();
    const inside = join(app, "work", "suite");
    await prepareSuiteCopy({ closureDir, suiteDir: inside, verifierNodeModules: nodeModules, closurePaths: Object.keys(closure), harness: HARNESS });
    expect(checkSuiteIsolation({ suiteDir: inside, appDir: app, verifierNodeModules: nodeModules }).join("\n")).toMatch(
      /inside the app/,
    );
  });

  it("fails when an ancestor directory holds a node_modules that imports could fall back to", async () => {
    const { closureDir, nodeModules, closure, suiteDir, app, root } = layout();
    mkdirSync(join(root, "results", "node_modules"), { recursive: true });
    await prepareSuiteCopy({ closureDir, suiteDir, verifierNodeModules: nodeModules, closurePaths: Object.keys(closure), harness: HARNESS });
    expect(checkSuiteIsolation({ suiteDir, appDir: app, verifierNodeModules: nodeModules }).join("\n")).toMatch(/node_modules/);
  });

  it("fails when the copy's node_modules is not the verifier's", async () => {
    const { closureDir, nodeModules, closure, suiteDir, app } = layout();
    await prepareSuiteCopy({ closureDir, suiteDir, verifierNodeModules: nodeModules, closurePaths: Object.keys(closure), harness: HARNESS });
    rmSync(join(suiteDir, "node_modules"));
    symlinkSync(join(app, "node_modules"), join(suiteDir, "node_modules"));
    expect(checkSuiteIsolation({ suiteDir, appDir: app, verifierNodeModules: nodeModules }).join("\n")).toMatch(/verifier/);
  });
});
