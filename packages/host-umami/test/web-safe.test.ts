// The main entry must load in a web route: no Docker, local runner (beyond its slim shared
// module), sandbox, database, process or patch code anywhere in its import graph, the workspace
// packages it imports included.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const IMPORT = /^\s*(?:import|export)\s[^"']*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;

/** Every module specifier reachable from a file, following relative imports and, when asked, the workspace's @rbw packages. */
function importGraph(entry: string, followWorkspace = true): { files: string[]; external: string[]; workspace: string[] } {
  const files = new Set<string>();
  const external = new Set<string>();
  const workspace = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2] ?? "";
      if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier));
      else if (specifier.startsWith("@rbw/")) {
        workspace.add(specifier);
        if (followWorkspace) visit(createRequire(file).resolve(specifier));
      } else external.add(specifier);
    }
  };
  visit(entry);
  return { files: [...files].sort(), external: [...external].sort(), workspace: [...workspace].sort() };
}

const FORBIDDEN = ["node:child_process", "child_process", "@vercel/sandbox", "@electric-sql/pglite", "pg", "tar-stream", "diff", "axios"];

describe("the main entry", () => {
  const graph = importGraph(join(SRC, "index.ts"));

  it("imports, among workspace packages, only the shared types, the schema, the importer and the runner's slim shared module", () => {
    expect(graph.workspace.filter((specifier) => specifier !== "@rbw/umami-driver/limits")).toEqual(["@rbw/admission", "@rbw/factory-contract", "@rbw/local-runner/shared", "@rbw/schema"]);
    expect(graph.files.filter((file) => file.startsWith(SRC)).map((file) => file.slice(SRC.length))).not.toContain("prepare.ts");
  });

  it("loads no process, Docker, sandbox, database, archive or patch module anywhere below it", () => {
    expect(graph.external.filter((specifier) => FORBIDDEN.includes(specifier))).toEqual([]);
    const runnerFiles = graph.files.filter((file) => file.includes("/local-runner/src/")).map((file) => file.slice(file.lastIndexOf("/") + 1));
    expect(runnerFiles.sort()).toEqual(["clock.ts", "shared.ts"]);
  });

  it("keeps the Docker export in the prepare entry", () => {
    const prepare = importGraph(join(SRC, "prepare.ts"), false);
    expect(prepare.workspace).toContain("@rbw/local-runner");
    expect(prepare.external).toContain("tar-stream");
  });
});
