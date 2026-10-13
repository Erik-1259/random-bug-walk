import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../../local-runner/test/support/synthetic.ts";
import { compareEntry, compareTracked, submission } from "../../src/tracked.ts";
import type { TrackedEntry } from "../../src/tracked.ts";

const TARGET = "src/target.ts";

function file(content: string, executable = false): TrackedEntry {
  return { type: "file", bytes: Buffer.from(content), linkname: null, executable };
}

function projection(): string {
  const dir = tempDir("rbw-solver-session-projection-");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, TARGET), "const a = 1;\nconst b = 2;\n");
  writeFileSync(join(dir, "README.md"), "# app\n");
  writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n");
  chmodSync(join(dir, "run.sh"), 0o755);
  symlinkSync("README.md", join(dir, "README.link"));
  return dir;
}

const PATHS = ["README.link", "README.md", "run.sh", TARGET];

function unchanged(): Map<string, TrackedEntry> {
  return new Map([
    ["README.link", { type: "symlink", bytes: Buffer.alloc(0), linkname: "README.md", executable: false }],
    ["README.md", file("# app\n")],
    ["run.sh", file("#!/bin/sh\n", true)],
    [TARGET, file("const a = 1;\nconst b = 2;\n")],
  ]);
}

describe("the tracked-file diff against the neutral commit", () => {
  it("finds nothing when the container holds the projection", () => {
    const dir = projection();
    const result = submission(dir, compareTracked(dir, PATHS, unchanged(), TARGET), TARGET);
    expect(result).toMatchObject({ scope: "in_scope", changed: [], target_patch: "" });
    expect(result.target_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is in scope with a patch when only the target changed", () => {
    const dir = projection();
    const current = unchanged();
    current.set(TARGET, file("const a = 1;\nconst b = 3;\n"));
    const result = submission(dir, compareTracked(dir, PATHS, current, TARGET), TARGET);
    expect(result.scope).toBe("in_scope");
    expect(result.changed).toEqual([{ path: TARGET, change: "modified" }]);
    expect(result.target_patch).toBe(`diff --git a/${TARGET} b/${TARGET}\n--- a/${TARGET}\n+++ b/${TARGET}\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n`);
  });

  it("is out of scope when any other tracked file was modified, deleted, retyped or changed mode", () => {
    const dir = projection();
    const cases: [string, (map: Map<string, TrackedEntry>) => void, string][] = [
      ["README.md", (map) => map.set("README.md", file("# changed\n")), "modified"],
      ["README.md", (map) => map.delete("README.md"), "deleted"],
      ["run.sh", (map) => map.set("run.sh", file("#!/bin/sh\n", false)), "mode"],
      ["README.link", (map) => map.set("README.link", file("# app\n")), "type"],
      ["README.link", (map) => map.set("README.link", { type: "symlink", bytes: Buffer.alloc(0), linkname: "/etc/passwd", executable: false }), "modified"],
    ];
    for (const [path, change, kind] of cases) {
      const current = unchanged();
      change(current);
      const result = submission(dir, compareTracked(dir, PATHS, current, TARGET), TARGET);
      expect(result.scope).toBe("out_of_scope");
      expect(result.changed).toEqual([{ path, change: kind }]);
    }
  });

  it("records a missing target with no bytes to grade", () => {
    const dir = projection();
    const current = unchanged();
    current.delete(TARGET);
    expect(submission(dir, compareTracked(dir, PATHS, current, TARGET), TARGET)).toMatchObject({ scope: "in_scope", target_sha256: null, changed: [{ path: TARGET, change: "deleted" }] });
  });

  it("compares content before mode", () => {
    expect(compareEntry(file("a"), file("b", true))).toBe("modified");
    expect(compareEntry(file("a"), file("a"))).toBeNull();
  });
});
