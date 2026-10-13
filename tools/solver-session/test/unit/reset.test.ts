// The cold-build reset, run for real: the snapshot and reset scripts and the kit's own
// rbw-check-cold run with /bin/sh against a directory tree laid out as the kit image lays out its
// build outputs (from kit/umami/build-outputs.txt), with every absolute path of rbw-check-cold
// moved under that tree. A simulated build writes what a build writes; the reset must then make
// the next build cold again, and again after a second build.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../../local-runner/test/support/synthetic.ts";
import { BuildOutputsError, RESET_SCRIPT, SNAPSHOT_SCRIPT, kitBuildOutputs, parseBuildOutputs } from "../../src/reset.ts";

const CHECK_COLD = fileURLToPath(new URL("../../../../kit/umami/bin/rbw-check-cold", import.meta.url));

/** rbw-check-cold with each absolute path under $RBW_ROOT; every replaced text must occur exactly once. */
function checkColdUnderRoot(): string {
  let script = readFileSync(CHECK_COLD, "utf8");
  const moves: [string, string][] = [
    ["APP=/workspace/app", 'APP="$RBW_ROOT/workspace/app"'],
    ["done < /opt/rbw/etc/build-outputs.txt", 'done < "$RBW_ROOT/opt/rbw/etc/build-outputs.txt"'],
    ["for dir in /var/tmp/rbw-app /var/tmp/rbw-db; do", 'for dir in "$RBW_ROOT/var/tmp/rbw-app" "$RBW_ROOT/var/tmp/rbw-db"; do'],
    ["find / -xdev", 'find "$RBW_ROOT" -xdev'],
    ["for dir in /root/.cache /root/.local/share/pnpm /root/.npm; do", 'for dir in "$RBW_ROOT/root/.cache" "$RBW_ROOT/root/.local/share/pnpm" "$RBW_ROOT/root/.npm"; do'],
  ];
  for (const [from, to] of moves) {
    expect(script.split(from)).toHaveLength(2);
    script = script.replace(from, to);
  }
  return script;
}

function sh(root: string, script: string, name: string): { code: number | null; out: string } {
  const result = spawnSync("/bin/sh", ["-c", script, name, root], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", RBW_ROOT: root } });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/** A tree with the image's build outputs: empty dirs and files, sticky dirs holding tracked files, tracked outputs. */
function imageTree(): string {
  const root = tempDir("rbw-solver-session-reset-");
  const app = join(root, "workspace/app");
  mkdirSync(join(root, "opt/rbw/etc"), { recursive: true });
  writeFileSync(join(root, "opt/rbw/etc/build-outputs.txt"), kitBuildOutputs().text);
  for (const dir of ["var/tmp/rbw-app", "var/tmp/rbw-db", "var/lib/rbw"]) mkdirSync(join(root, dir), { recursive: true });
  const entries = kitBuildOutputs().entries;
  for (const { kind, path } of entries.filter((entry) => entry.kind === "sticky")) {
    mkdirSync(join(app, path, "src"), { recursive: true });
    writeFileSync(join(app, path, "package.json"), `{"name":"${path}"}\n`);
    chmodSync(join(app, path), 0o1775);
    expect(kind).toBe("sticky");
  }
  for (const { kind, path } of entries) {
    const target = join(app, path);
    mkdirSync(join(target, ".."), { recursive: true });
    if (kind === "dir") mkdirSync(target, { mode: 0o755 });
    if (kind === "file") writeFileSync(target, "", { mode: 0o644 });
    if (kind === "tracked") writeFileSync(target, `pristine ${path}\n`, { mode: 0o644 });
  }
  return root;
}

/** What a build (and a run of the app) leaves behind. */
function simulateBuild(root: string, round: number): void {
  const app = join(root, "workspace/app");
  mkdirSync(join(app, ".next/static/chunks"), { recursive: true });
  writeFileSync(join(app, ".next/BUILD_ID"), `build-${String(round)}\n`);
  writeFileSync(join(app, ".next/static/chunks/main.js.map"), "{}\n");
  chmodSync(join(app, ".next"), 0o700);
  writeFileSync(join(app, "generated/prisma.js"), "module.exports = {};\n");
  writeFileSync(join(app, "packages/api-client/dist/index.js"), "export {};\n");
  writeFileSync(join(app, "packages/mcp/dist/index.js"), "export {};\n");
  writeFileSync(join(app, "src/generated/types.ts"), "export {};\n");
  writeFileSync(join(app, "next-env.d.ts"), "/// <reference types=\"next\" />\n");
  for (const file of ["public/openapi.json", "public/recorder.js", "public/script.js"]) writeFileSync(join(app, file), `built ${String(round)}\n`);
  writeFileSync(join(app, `packages/api-client/tsup.config.bundled_${String(round)}.mjs`), "export default {};\n");
  writeFileSync(join(app, "src/tracker/index.d.ts"), `rewritten by build ${String(round)}\n`);
  chmodSync(join(app, "src/tracker/index.d.ts"), 0o600);
  mkdirSync(join(app, ".turbo"), { recursive: true });
  mkdirSync(join(root, "var/tmp/rbw-app/.cache/next"), { recursive: true });
  writeFileSync(join(root, "var/tmp/rbw-app/.cache/next/x"), "x");
  writeFileSync(join(root, "var/tmp/rbw-db/pgsql_tmp1"), "x");
}

describe("the build-outputs list", () => {
  it("parses the repository's list, every kind with its path", () => {
    const { entries } = kitBuildOutputs();
    expect(entries.filter((entry) => entry.kind === "dir").map((entry) => entry.path)).toEqual([".next", "generated", "packages/api-client/dist", "packages/mcp/dist", "src/generated"]);
    expect(entries.filter((entry) => entry.kind === "sticky").map((entry) => entry.path)).toEqual(["packages/api-client", "packages/mcp"]);
    expect(entries.filter((entry) => entry.kind === "tracked")).toHaveLength(3);
    expect(entries.filter((entry) => entry.kind === "file")).toHaveLength(4);
  });

  it("refuses an unknown kind, an unsafe path and a malformed line", () => {
    expect(() => parseBuildOutputs("cache .turbo\n")).toThrow(BuildOutputsError);
    expect(() => parseBuildOutputs("dir ../etc\n")).toThrow(/unsafe/);
    expect(() => parseBuildOutputs("dir /etc\n")).toThrow(/unsafe/);
    expect(() => parseBuildOutputs("dir a b\n")).toThrow(/malformed/);
    expect(() => parseBuildOutputs("# only a comment\n")).toThrow(/empty/);
  });
});

describe("the cold-build reset", () => {
  it("lets the build after each rebuild pass rbw-check-cold, twice", () => {
    const root = imageTree();
    const checkCold = checkColdUnderRoot();
    expect(sh(root, checkCold, "rbw-check-cold")).toEqual({ code: 0, out: "" });
    expect(sh(root, SNAPSHOT_SCRIPT, "rbw-snapshot")).toMatchObject({ code: 0 });
    for (const round of [1, 2]) {
      simulateBuild(root, round);
      const warm = sh(root, checkCold, "rbw-check-cold");
      expect(warm.code).toBe(1);
      expect(warm.out).toContain("build output directory is not empty: .next");
      expect(sh(root, RESET_SCRIPT, "rbw-reset")).toMatchObject({ code: 0 });
      expect(sh(root, checkCold, "rbw-check-cold")).toEqual({ code: 0, out: "" });
    }
  });

  it("restores tracked outputs' contents and modes, sticky directories' own entries and dir modes", () => {
    const root = imageTree();
    const app = join(root, "workspace/app");
    expect(sh(root, SNAPSHOT_SCRIPT, "rbw-snapshot")).toMatchObject({ code: 0 });
    simulateBuild(root, 1);
    expect(sh(root, RESET_SCRIPT, "rbw-reset")).toMatchObject({ code: 0 });
    expect(readFileSync(join(app, "src/tracker/index.d.ts"), "utf8")).toBe("pristine src/tracker/index.d.ts\n");
    expect(statSync(join(app, "src/tracker/index.d.ts")).mode & 0o7777).toBe(0o644);
    expect(statSync(join(app, ".next")).mode & 0o7777).toBe(0o755);
    expect(readdirSync(join(app, "packages/api-client")).sort()).toEqual(["dist", "package.json", "src"]);
    expect(statSync(join(app, "packages/api-client")).mode & 0o7777).toBe(0o1775);
    expect(readdirSync(join(app, "packages/api-client/dist"))).toEqual([]);
    expect(readFileSync(join(app, "packages/mcp/package.json"), "utf8")).toBe('{"name":"packages/mcp"}\n');
    expect(readdirSync(join(root, "var/tmp/rbw-app"))).toEqual([]);
    expect(existsSync(join(app, ".turbo"))).toBe(false);
  });

  it("refuses to reset without a snapshot, and to snapshot twice", () => {
    const root = imageTree();
    expect(sh(root, RESET_SCRIPT, "rbw-reset")).toMatchObject({ code: 2, out: "rbw-reset: no snapshot\n" });
    expect(sh(root, SNAPSHOT_SCRIPT, "rbw-snapshot").code).toBe(0);
    expect(sh(root, SNAPSHOT_SCRIPT, "rbw-snapshot")).toMatchObject({ code: 2, out: "rbw-snapshot: a snapshot already exists\n" });
  });
});
