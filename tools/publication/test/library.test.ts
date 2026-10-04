import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanEnv, commit, initRepo, packageDir, run, tempDir, writeFile, writePatterns, writeStubGitleaks } from "./support.ts";

const TERM = "synthetic-library-term";

async function runModule(source: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return run(process.execPath, ["--input-type=module", "-e", source], { cwd: packageDir, env: cleanEnv() });
}

describe("PUB-02 scanner library", () => {
  it("imports scan from @rbw/publication under Node directly and scans git, files and text", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    commit(repo, { "b.txt": `x\n${TERM}\n` }, "feat: b\n");
    const head = commit(repo, { "c.txt": "c\n" }, "feat: c\n");
    writeFile(join(root, "files", "f.txt"), `${TERM}\n`);
    const patterns = writePatterns(root, `${TERM}\n`);
    const stub = writeStubGitleaks(root);
    const request = {
      patternFile: patterns,
      gitleaksCommand: stub.command,
      git: { repository: repo, head, exclude: [base] },
    };
    const source = `
      import { scan } from "@rbw/publication";
      const request = ${JSON.stringify(request)};
      const git = await scan({ ...request, texts: [{ name: "pr-title", content: new TextEncoder().encode("${TERM}") }] });
      const files = await scan({ patternFile: request.patternFile, gitleaksCommand: request.gitleaksCommand,
        files: { root: ${JSON.stringify(join(root, "files"))}, paths: ["f.txt"] } });
      const all = await scan({ ...request, git: { ...request.git, exclude: [] } });
      const none = await scan({ patternFile: request.patternFile, gitleaksCommand: request.gitleaksCommand });
      const both = await scan({ ...request, files: { root: ".", paths: ["package.json"] } });
      const missing = await scan({ ...request, patternFile: "/nonexistent/patterns" });
      console.log(JSON.stringify({ git, files, all, none, both, missing }));
    `;
    const result = await runModule(source);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      git: { outcome: "blocked", locations: ["b.txt:2", "pr-title:1"] },
      files: { outcome: "blocked", locations: ["f.txt:1"] },
      all: { outcome: "blocked", locations: ["b.txt:2"] },
      none: { outcome: "unavailable" },
      both: { outcome: "unavailable" },
      missing: { outcome: "unavailable" },
    });
  });

  it("scans in-root files whose first segment begins with two dots and refuses paths outside the root", async () => {
    const root = tempDir();
    const files = join(root, "files");
    writeFile(join(files, "..config"), "fine\n");
    writeFile(join(files, "..data", "file.txt"), `ok\n${TERM}\n`);
    writeFile(join(files, "a", "b.txt"), "fine\n");
    writeFile(join(root, "outside.txt"), "fine\n");
    const patterns = writePatterns(root, `${TERM}\n`);
    const stub = writeStubGitleaks(root);
    const result = await runModule(`
      import { scan } from "@rbw/publication";
      const base = { patternFile: ${JSON.stringify(patterns)}, gitleaksCommand: ${JSON.stringify(stub.command)} };
      const root = ${JSON.stringify(files)};
      const run = (paths) => scan({ ...base, files: { root, paths } });
      console.log(JSON.stringify({
        clean: await run(["..config"]),
        blocked: await run(["..config", "..data/file.txt"]),
        parent: await run(["../outside.txt"]),
        dots: await run([".."]),
        absolute: await run([${JSON.stringify(join(root, "outside.txt"))}]),
        escape: await run(["a/../../x"]),
      }));
    `);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      clean: { outcome: "clean" },
      blocked: { outcome: "blocked", locations: ["..data/file.txt:2"] },
      parent: { outcome: "unavailable" },
      dots: { outcome: "unavailable" },
      absolute: { outcome: "unavailable" },
      escape: { outcome: "unavailable" },
    });
  });

  it("never throws for malformed requests", async () => {
    const result = await runModule(`
      import { scan } from "@rbw/publication";
      const results = [await scan(undefined), await scan({}), await scan({ patternFile: 5, texts: "x" })];
      console.log(JSON.stringify(results));
    `);
    expect(JSON.parse(result.stdout)).toEqual([{ outcome: "unavailable" }, { outcome: "unavailable" }, { outcome: "unavailable" }]);
  });
});

describe("PUB-02 gitleaks host form", () => {
  it("documents the Docker form pinned by digest and never pulling", () => {
    const readme = readFileSync(join(packageDir, "README.md"), "utf8");
    const form = [
      "docker run --rm --pull never --network none -v {dir}:{dir}",
      "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f",
    ].join(" ");
    expect(readme).toContain(form);
    expect(readme).not.toMatch(/gitleaks:v8\.30\.1(?!@sha256:)/);
  });
});
