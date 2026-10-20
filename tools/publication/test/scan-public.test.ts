import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STUB_LEAK_MARKER,
  boundedLeakPattern,
  cleanEnv,
  commit,
  forms,
  initRepo,
  outputLines,
  runCli,
  tempDir,
  writeFile,
  writePatterns,
  writeStubGitleaks,
  type RunResult,
  type StubGitleaks,
} from "./support.ts";

const TERM = "synthetic-forbidden-term";
const TERMS = `# synthetic test list\n${TERM}\n`;
const NOT_RUN = "private-pattern scan: not run on this route (required in CI before merge)";

function checks(outcome: "clean" | "blocked" | "unavailable"): string {
  return `credential and attribution checks: ${outcome}`;
}

function expectPublic(result: RunResult, outcome: "clean" | "blocked" | "unavailable", locations: string[] = []): void {
  expect(outputLines(result)).toEqual([checks(outcome), ...locations, NOT_RUN]);
  expect(result.code).toBe({ clean: 0, blocked: 1, unavailable: 2 }[outcome]);
}

function gitleaksCalls(stub: StubGitleaks): string {
  return existsSync(stub.callsLog) ? readFileSync(stub.callsLog, "utf8") : "";
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

describe("PUB-02 full scan: pattern list stays required", () => {
  it("answers unavailable without --patterns exactly as before, without running gitleaks", async () => {
    const root = tempDir();
    writeFile(join(root, "a.txt"), "x\n");
    const stub = writeStubGitleaks(root);
    const result = await runCli(["scan", "--gitleaks", stub.command, "--files", "a.txt"], { cwd: root });
    expect(result.stdout).toBe("unavailable\n");
    expect(result.stderr).toBe("scan unavailable: usage\n");
    expect(result.code).toBe(2);
    expect(gitleaksCalls(stub)).toBe("");
  });
});

describe("PUB-02 public-source route: scan-public", () => {
  it("finds credentials and attribution trailers in files, commit messages and PR text", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    const first = commit(repo, { "b.txt": `x\nconst key = "${STUB_LEAK_MARKER}-value";\n` }, `feat: add b\n\n${STUB_LEAK_MARKER}\n`);
    const second = commit(repo, { "c.txt": "c\n" }, `feat: add c\n\nBody.\n\n${forms.coauthored}: x <x@example.invalid>\n`);
    const title = writeFile(join(root, "title.txt"), "fix: synthetic title");
    const body = writeFile(join(root, "body.md"), `Summary.\n\n${forms.signedOff}: x\n`);
    const reply = writeFile(join(root, "reply.md"), `hello\n${STUB_LEAK_MARKER}\n`);
    const stub = writeStubGitleaks(root);
    const result = await runCli(
      [
        "scan-public",
        "--gitleaks",
        stub.command,
        "--range",
        `${base}..HEAD`,
        "--text",
        `pr-title=${title}`,
        "--text",
        `pr-body=${body}`,
        "--text",
        `pr-comment=${reply}`,
      ],
      { cwd: repo },
    );
    const commits = [`commit-${short(first)}:3`, `commit-${short(second)}:5`].sort();
    expectPublic(result, "blocked", ["b.txt:2", ...commits, "pr-body:3", "pr-comment:2"]);
    const all = result.stdout + result.stderr;
    expect(all).not.toContain(STUB_LEAK_MARKER);
    expect(all).not.toContain(forms.coauthored);
    expect(all).not.toContain(forms.signedOff);
  });

  it("finds a credential in an added path and reports only its path-list position", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    const head = commit(repo, { [`keys/${STUB_LEAK_MARKER}-value.txt`]: "nothing here\n", "z.txt": "z\n" }, "feat: add keys\n");
    const stub = writeStubGitleaks(root);
    const range = await runCli(["scan-public", "--gitleaks", stub.command, "--range", `${base}..HEAD`], { cwd: repo });
    // The sorted list is keys, keys/<marker>-value.txt and z.txt.
    expectPublic(range, "blocked", [`paths-${short(head)}:2`]);
    writeFile(join(root, "work", `${STUB_LEAK_MARKER}.txt`), "x\n");
    const files = await runCli(["scan-public", "--gitleaks", stub.command, "--files", `${STUB_LEAK_MARKER}.txt`], { cwd: join(root, "work") });
    expectPublic(files, "blocked", ["paths:1"]);
    for (const result of [range, files]) expect(result.stdout + result.stderr).not.toContain(STUB_LEAK_MARKER);
  });

  it("reports other violations in a file with a credential in its path under the path-list position", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    const head = commit(repo, { [`${STUB_LEAK_MARKER}.md`]: `ok\n${forms.signedOff}: x\n` }, "docs: add\n");
    const stub = writeStubGitleaks(root);
    const result = await runCli(["scan-public", "--gitleaks", stub.command, "--range", `${base}..HEAD`], { cwd: repo });
    expectPublic(result, "blocked", [`paths-${short(head)}:1`]);
    expect(result.stdout + result.stderr).not.toContain(STUB_LEAK_MARKER);
  });

  it("finds a credential that needs a boundary after it in a directory name and before an extension", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    const tree = { [`cfg/${STUB_LEAK_MARKER}/notes.md`]: `ok\n${forms.signedOff}: x\n`, [`keys/${STUB_LEAK_MARKER}.txt`]: "x\n" };
    const head = commit(repo, tree, "docs: add\n");
    const stub = writeStubGitleaks(root, { leakPattern: boundedLeakPattern(STUB_LEAK_MARKER) });
    const result = await runCli(["scan-public", "--gitleaks", stub.command, "--range", `${base}..HEAD`], { cwd: repo });
    // The sorted list is cfg, cfg/<marker>, cfg/<marker>/notes.md, keys and keys/<marker>.txt.
    const list = `paths-${short(head)}`;
    expectPublic(result, "blocked", [`${list}:2`, `${list}:3`, `${list}:5`]);
    expect(result.stdout + result.stderr).not.toContain(STUB_LEAK_MARKER);
  });

  it("checks --files input and reports a clean result for the checks that ran", async () => {
    const root = tempDir();
    writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFile(join(root, "notes.md"), `first\n${forms.generatedWith} a tool\n`);
    const stub = writeStubGitleaks(root);
    expectPublic(await runCli(["scan-public", "--gitleaks", stub.command, "--files", "src/a.ts"], { cwd: root }), "clean");
    expectPublic(await runCli(["scan-public", "--gitleaks", stub.command, "--files", "src/a.ts", "notes.md"], { cwd: root }), "blocked", ["notes.md:2"]);
  });

  it("never reports the private-pattern scan as clean", async () => {
    const root = tempDir();
    writeFile(join(root, "a.txt"), `ok\n${TERM}\n`);
    const patterns = writePatterns(root, TERMS);
    const stub = writeStubGitleaks(root);
    const full = await runCli(["scan", "--patterns", patterns, "--gitleaks", stub.command, "--files", "a.txt"], { cwd: root });
    expect(outputLines(full)).toEqual(["blocked", "a.txt:2"]);

    const clean = await runCli(["scan-public", "--gitleaks", stub.command, "--files", "a.txt"], { cwd: root });
    const unavailable = await runCli(["scan-public", "--gitleaks", join(root, "missing-gitleaks"), "--files", "a.txt"], { cwd: root });
    expectPublic(clean, "clean");
    expectPublic(unavailable, "unavailable");
    for (const result of [clean, unavailable]) {
      const lines = outputLines(result);
      expect(lines).not.toContain("clean");
      expect(lines.filter((line) => /pattern/i.test(line))).toEqual([NOT_RUN]);
      expect(result.stdout + result.stderr).not.toContain(TERM);
    }
  });

  it("refuses a pattern list and the options only the pattern check uses", async () => {
    const root = tempDir();
    writeFile(join(root, "a.txt"), "x\n");
    const patterns = writePatterns(root, TERMS);
    const stub = writeStubGitleaks(root);
    const refused = [
      ["--patterns", patterns],
      [`--patterns=${patterns}`],
      ["--repository", "synthetic-owner/synthetic-repo"],
      ["--license", "a.txt"],
    ];
    for (const extra of refused) {
      const result = await runCli(["scan-public", "--gitleaks", stub.command, ...extra, "--files", "a.txt"], { cwd: root });
      expectPublic(result, "unavailable");
      expect(result.stderr).toBe("scan unavailable: usage\n");
      expect(result.stdout + result.stderr).not.toContain(patterns);
    }
    expect(gitleaksCalls(stub)).toBe("");
  });

  it("answers unavailable when gitleaks cannot run", async () => {
    const root = tempDir();
    writeFile(join(root, "a.txt"), "x\n");
    const missing = await runCli(["scan-public", "--gitleaks", join(root, "missing-gitleaks"), "--files", "a.txt"], { cwd: root });
    expectPublic(missing, "unavailable");
    expect(missing.stderr).toBe("scan unavailable: gitleaks\n");
    const notOnPath = await runCli(["scan-public", "--files", "a.txt"], { cwd: root, env: cleanEnv({ PATH: join(root, "empty-bin") }) });
    expectPublic(notOnPath, "unavailable");
    const otherVersion = writeStubGitleaks(tempDir(), { version: "8.0.0" });
    expectPublic(await runCli(["scan-public", "--gitleaks", otherVersion.command, "--files", "a.txt"], { cwd: root }), "unavailable");
  });

  it("answers unavailable for a call without inputs or with --range and --files together", async () => {
    const root = tempDir();
    writeFile(join(root, "a.txt"), "x\n");
    const stub = writeStubGitleaks(root);
    expectPublic(await runCli(["scan-public", "--gitleaks", stub.command], { cwd: root }), "unavailable");
    expectPublic(await runCli(["scan-public", "--gitleaks", stub.command, "--range", "HEAD~1..HEAD", "--files", "a.txt"], { cwd: root }), "unavailable");
  });
});
