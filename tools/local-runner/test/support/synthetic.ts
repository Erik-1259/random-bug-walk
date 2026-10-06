// Synthetic inputs for the runner's tests: a five-line target file at the real target path, probe
// patches over it in the shapes package's format, an alternative fix, a source manifest, a term
// list whose terms exist only in these tests, and the app tree the kit image would hold.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "tar-stream";

export const TARGET = "src/queries/sql/pageviews/getPageviewStats.ts";
export const HOST_COMMIT = "ec0ff50388c264ed8ce46f00967e92f7e71476ae";
export const STRICT_TERM = "synthetic-local-runner-canary";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function tempDir(prefix = "rbw-local-runner-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export const CLEAN = [
  "// synthetic target for local-runner tests",
  "export function synthetic(zone: string) {",
  "  const unit = 'day';",
  "  return range(unit, zone);",
  "}",
  "",
].join("\n");

export const PLANTED = CLEAN.replace("  return range(unit, zone);", "  return range(unit);");
export const PARTIAL = PLANTED.replace("  return range(unit);", "  return range(unit, zone === 'Pacific/Auckland' ? zone : 'UTC');");
export const STUB = PLANTED.replace("  const unit = 'day';\n", "  const unit = 'day';\n  if (zone !== 'UTC') return [];\n");
export const ALTERNATIVE = PLANTED.replace("  return range(unit);", "  return range(unit, zone || 'UTC');");

const HEADER = `diff --git a/${TARGET} b/${TARGET}\n--- a/${TARGET}\n+++ b/${TARGET}\n`;

export const MUTATION_PATCH = `${HEADER}@@ -1,5 +1,5 @@
 // synthetic target for local-runner tests
 export function synthetic(zone: string) {
   const unit = 'day';
-  return range(unit, zone);
+  return range(unit);
 }
`;

export const PARTIAL_PATCH = `${HEADER}@@ -1,5 +1,5 @@
 // synthetic target for local-runner tests
 export function synthetic(zone: string) {
   const unit = 'day';
-  return range(unit);
+  return range(unit, zone === 'Pacific/Auckland' ? zone : 'UTC');
 }
`;

export const STUB_PATCH = `${HEADER}@@ -1,5 +1,6 @@
 // synthetic target for local-runner tests
 export function synthetic(zone: string) {
   const unit = 'day';
+  if (zone !== 'UTC') return [];
   return range(unit);
 }
`;

export const ALTERNATIVE_PATCH = `${HEADER}@@ -1,5 +1,5 @@
 // synthetic target for local-runner tests
 export function synthetic(zone: string) {
   const unit = 'day';
-  return range(unit);
+  return range(unit, zone || 'UTC');
 }
`;

const pass = { outcome: "pass" };
const counts = { outcome: "assertion_fail", reason: "local_day_counts_mismatch" };
const labels = { outcome: "assertion_fail", reason: "bucket_labels_mismatch" };

export interface ProbeOverrides {
  mutationPatch?: string;
  partialPatch?: string;
  cleanSha256?: string;
  plantedSha256?: string;
  fixedResultSha256?: string;
  partialResultSha256?: string;
}

/** Writes a probe directory in the shapes package's layout and returns its path. */
export function writeProbeDir(overrides: ProbeOverrides = {}): string {
  const dir = tempDir("rbw-local-runner-probes-");
  const clean = overrides.cleanSha256 ?? sha256(CLEAN);
  const planted = overrides.plantedSha256 ?? sha256(PLANTED);
  const data = {
    checks: ["tzarg.auckland-day-counts", "tzarg.kolkata-day-counts", "tzarg.la-day-counts", "tzarg.utc-day-counts"],
    clean_sha256: clean,
    fixed_reference: {
      base_sha256: planted,
      method: "reverse_mutation_patch",
      note: "Synthetic: reversing the mutation gives the clean file.",
      result_sha256: overrides.fixedResultSha256 ?? clean,
    },
    host_commit: HOST_COMMIT,
    invalid_outcomes: { note: "Synthetic.", outcomes: ["build_error", "crash", "missing_result", "setup_failure", "timeout"] },
    planted_sha256: planted,
    probes: [
      {
        base_sha256: clean,
        description: "Synthetic mutation.",
        expected: { "tzarg.auckland-day-counts": counts, "tzarg.kolkata-day-counts": counts, "tzarg.la-day-counts": counts, "tzarg.utc-day-counts": pass },
        id: "mutation",
        patch: "mutation.patch",
        result_sha256: planted,
      },
      {
        base_sha256: planted,
        description: "Synthetic partial fix.",
        expected: { "tzarg.auckland-day-counts": pass, "tzarg.kolkata-day-counts": counts, "tzarg.la-day-counts": counts, "tzarg.utc-day-counts": pass },
        id: "partial",
        patch: "partial.patch",
        result_sha256: overrides.partialResultSha256 ?? sha256(PARTIAL),
      },
      {
        base_sha256: planted,
        description: "Synthetic stub fix.",
        expected: { "tzarg.auckland-day-counts": labels, "tzarg.kolkata-day-counts": labels, "tzarg.la-day-counts": labels, "tzarg.utc-day-counts": pass },
        id: "stub",
        patch: "stub.patch",
        result_sha256: sha256(STUB),
      },
    ],
    scope: "Synthetic.",
    shape_id: "DT-1.tz-arg",
    target_path: TARGET,
  };
  writeFileSync(join(dir, "probes.json"), `${JSON.stringify(data, null, 2)}\n`);
  writeFileSync(join(dir, "mutation.patch"), overrides.mutationPatch ?? MUTATION_PATCH);
  writeFileSync(join(dir, "partial.patch"), overrides.partialPatch ?? PARTIAL_PATCH);
  writeFileSync(join(dir, "stub.patch"), STUB_PATCH);
  return dir;
}

/** Writes an alternative-fix directory (record and patch) and returns its path. */
export function writeAlternativeDir(resultSha256 = sha256(ALTERNATIVE)): string {
  const dir = tempDir("rbw-local-runner-alternative-");
  const record = { base_sha256: sha256(PLANTED), description: "Synthetic alternative fix.", patch: "alternative-fix.patch", result_sha256: resultSha256, target_path: TARGET };
  writeFileSync(join(dir, "alternative-fix.json"), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(dir, "alternative-fix.patch"), ALTERNATIVE_PATCH);
  return dir;
}

/** The pinned source of the synthetic app, by path. */
export const SOURCE_FILES: Record<string, string> = {
  "README.md": "# Synthetic app\n",
  "package.json": '{"name":"synthetic-app"}\n',
  "src/index.ts": "export const index = 1;\n",
  [TARGET]: CLEAN,
};

/** A source manifest in the projection package's format, for SOURCE_FILES at the pinned commit. */
export function writeManifest(dir: string): string {
  const files = Object.entries(SOURCE_FILES)
    .map(([path, content]) => ({ mode: "100644", path, sha256: sha256(content), size_bytes: Buffer.byteLength(content) }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify({ files, host_commit: HOST_COMMIT }));
  return path;
}

export function writeTerms(dir: string): string {
  const path = join(dir, "terms.txt");
  writeFileSync(path, `# synthetic terms for tests only\nstrict:${STRICT_TERM}\ngeneric:synthetic-generic-word\n`);
  return path;
}

export interface TarEntry {
  name: string;
  type?: "file" | "directory" | "symlink";
  content?: string;
  mode?: number;
  linkname?: string;
}

/** A tar archive in the layout `docker cp <container>:/workspace/app -` writes: entries under `app/`. */
export async function tarOf(entries: readonly TarEntry[]): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  archive.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk as Uint8Array));
  });
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", resolve);
    archive.on("error", reject);
  });
  for (const entry of entries) {
    const type = entry.type ?? "file";
    if (type === "file") {
      archive.entry({ name: entry.name, mode: entry.mode ?? 0o644 }, entry.content ?? "");
    } else if (type === "directory") {
      archive.entry({ name: entry.name, type: "directory", mode: entry.mode ?? 0o755 });
    } else {
      archive.entry({ name: entry.name, type: "symlink", linkname: entry.linkname ?? "", mode: 0o777 });
    }
  }
  archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

/** The kit image's /workspace/app as a tar stream: the source, plus what the kit adds that is not source. */
export function appTree(extra: readonly TarEntry[] = [], files: Record<string, string> = SOURCE_FILES): Promise<Buffer> {
  return tarOf([
    { name: "app", type: "directory" },
    ...Object.entries(files).map(([path, content]) => ({ name: `app/${path}`, content })),
    { name: "app/src/proxy.ts", content: "export const proxy = 1;\n" },
    { name: "app/next-env.d.ts", content: "" },
    { name: "app/.next", type: "directory" },
    { name: "app/node_modules/synthetic-dep/index.js", content: "module.exports = 1;\n" },
    { name: "app/node_modules/.bin/synthetic", type: "symlink", linkname: "../synthetic-dep/index.js" },
    ...extra,
  ]);
}

/** A synthetic kit stage: the directory the driver's stage-kit.ts writes, with a one-file fixture. */
export function writeKitStage(dir: string): string {
  const stage = join(dir, "kit-stage");
  mkdirSync(join(stage, "umami-fixture"), { recursive: true });
  writeFileSync(join(stage, "umami-fixture", "package.json"), '{"name":"synthetic-fixture"}\n');
  return stage;
}
