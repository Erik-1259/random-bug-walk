import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PINNED_GITLEAKS_VERSION,
  STUB_LEAK_MARKER,
  cleanEnv,
  commit,
  forms,
  git,
  initRepo,
  outputLines,
  cliPath,
  run,
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

interface ScanOutcome {
  result: RunResult;
  lines: string[];
  patterns: string;
  stub: StubGitleaks;
}

async function scanFiles(
  files: Record<string, string | Uint8Array>,
  options: { terms?: string | Uint8Array; args?: string[]; stub?: StubGitleaks; paths?: string[] } = {},
): Promise<ScanOutcome> {
  const root = tempDir();
  const work = join(root, "work");
  for (const [path, content] of Object.entries(files)) writeFile(join(work, path), content);
  const patterns = writePatterns(root, options.terms ?? TERMS);
  const stub = options.stub ?? writeStubGitleaks(root);
  const result = await runCli(
    [
      "scan",
      "--patterns",
      patterns,
      "--gitleaks",
      stub.command,
      ...(options.args ?? []),
      "--files",
      ...(options.paths ?? Object.keys(files)),
    ],
    { cwd: work },
  );
  return { result, lines: outputLines(result), patterns, stub };
}

function expectBlocked(outcome: ScanOutcome, locations: string[]): void {
  expect(outcome.lines).toEqual(["blocked", ...locations]);
  expect(outcome.result.code).toBe(1);
}

function expectClean(outcome: ScanOutcome): void {
  expect(outcome.result.stdout).toBe("clean\n");
  expect(outcome.result.code).toBe(0);
}

function expectUnavailable(result: RunResult): void {
  expect(outputLines(result)).toEqual(["unavailable"]);
  expect(result.code).toBe(2);
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

describe("PUB-02 scanner CLI: invocation", () => {
  it("prints clean and exits 0 for content without violations", async () => {
    expectClean(await scanFiles({ "README.md": "plain text\n" }));
  });

  it("treats --range together with --files as a usage error", async () => {
    const outcome = await scanFiles({ "a.txt": "x\n" }, { args: ["--range", "HEAD~1..HEAD"] });
    expectUnavailable(outcome.result);
  });

  it("treats a call without inputs, an unknown flag or an invalid text name as unavailable", async () => {
    const root = tempDir();
    const patterns = writePatterns(root, TERMS);
    const stub = writeStubGitleaks(root);
    const base = ["scan", "--patterns", patterns, "--gitleaks", stub.command];
    expectUnavailable(await runCli(base, { cwd: root }));
    expectUnavailable(await runCli([...base, "--bogus", "--files", "patterns.txt"], { cwd: root }));
    expectUnavailable(await runCli([...base, "--text", "bad name=patterns.txt"], { cwd: root }));
    expectUnavailable(await runCli([...base, "--text", "../x=patterns.txt"], { cwd: root }));
    expectUnavailable(await runCli(["frobnicate"], { cwd: root }));
  });

  it("reports locations from --files and --text in one call", async () => {
    const root = tempDir();
    writeFile(join(root, "body.md"), `line one\n${TERM}\n`);
    const outcome = await scanFiles(
      { "src/a.ts": `// ${TERM}\n` },
      { args: ["--text", `pr-body=${join(root, "body.md")}`] },
    );
    expectBlocked(outcome, ["pr-body:2", "src/a.ts:1"]);
  });

  it("reports locations from --range and --text in one call", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    commit(repo, { "b.txt": `x\n${TERM}\n` }, "feat: add b\n");
    writeFile(join(root, "title.txt"), TERM);
    const patterns = writePatterns(root, TERMS);
    const stub = writeStubGitleaks(root);
    const result = await runCli(
      ["scan", "--patterns", patterns, "--gitleaks", stub.command, "--range", `${base}..HEAD`, "--text", `pr-title=${join(root, "title.txt")}`],
      { cwd: repo },
    );
    expect(outputLines(result)).toEqual(["blocked", "b.txt:2", "pr-title:1"]);
    expect(result.code).toBe(1);
  });

  it("takes the gitleaks command from RBW_GITLEAKS_COMMAND when --gitleaks is absent", async () => {
    const root = tempDir();
    writeFile(join(root, "work", "app.ts"), `a\nb\nconst key = "${STUB_LEAK_MARKER}";\n`);
    const patterns = writePatterns(root, TERMS);
    const stub = writeStubGitleaks(root);
    const args = ["scan", "--patterns", patterns, "--files", "app.ts"];
    const viaEnv = await runCli(args, { cwd: join(root, "work"), env: cleanEnv({ RBW_GITLEAKS_COMMAND: stub.command }) });
    expect(outputLines(viaEnv)).toEqual(["blocked", "app.ts:3"]);
    const missing = await runCli(args, {
      cwd: join(root, "work"),
      env: cleanEnv({ RBW_GITLEAKS_COMMAND: join(root, "no-such-gitleaks") }),
    });
    expectUnavailable(missing);
    const flagWins = await runCli([...args.slice(0, 3), "--gitleaks", stub.command, ...args.slice(3)], {
      cwd: join(root, "work"),
      env: cleanEnv({ RBW_GITLEAKS_COMMAND: join(root, "no-such-gitleaks") }),
    });
    expect(outputLines(flagWins)).toEqual(["blocked", "app.ts:3"]);
  });

  it("falls back to gitleaks on PATH, which is unavailable when absent", async () => {
    const root = tempDir();
    writeFile(join(root, "work", "a.txt"), "x\n");
    const patterns = writePatterns(root, TERMS);
    const result = await runCli(["scan", "--patterns", patterns, "--files", "a.txt"], {
      cwd: join(root, "work"),
      env: cleanEnv({ PATH: join(root, "empty-bin") }),
    });
    expectUnavailable(result);
  });

  it("prints the pinned gitleaks version", async () => {
    const result = await runCli(["gitleaks-version"]);
    expect(result.stdout).toBe(`${PINNED_GITLEAKS_VERSION}\n`);
    expect(result.code).toBe(0);
  });

  it("refuses a --files path outside the current directory", async () => {
    const root = tempDir();
    writeFile(join(root, "outside.txt"), "x\n");
    const outcome = await scanFiles({ "a.txt": "x\n" }, { paths: ["a.txt", join(root, "outside.txt")] });
    expectUnavailable(outcome.result);
  });

  it("scans in-root paths whose first segment begins with two dots", async () => {
    const clean = await scanFiles({ "..config": "fine\n", "..data/file.txt": "fine\n" });
    expectClean(clean);
    const blocked = await scanFiles({ "..config": "fine\n", "..data/file.txt": `ok\n${TERM}\n` });
    expectBlocked(blocked, ["..data/file.txt:2"]);
  });

  it("refuses --files paths that resolve to or outside the root", async () => {
    for (const path of ["../outside.txt", "..", "a/../../x", "a/../.."]) {
      expectUnavailable((await scanFiles({ "a/b.txt": "x\n" }, { paths: ["a/b.txt", path] })).result);
    }
  });
});

describe("PUB-02 scanner CLI: private pattern list", () => {
  it("is unavailable when the pattern file is missing", async () => {
    const root = tempDir();
    writeFile(join(root, "a.txt"), "x\n");
    const stub = writeStubGitleaks(root);
    const missing = join(root, "missing-patterns.txt");
    const result = await runCli(["scan", "--patterns", missing, "--gitleaks", stub.command, "--files", "a.txt"], { cwd: root });
    expectUnavailable(result);
    expect(result.stdout + result.stderr).not.toContain(missing);
  });

  it("is unavailable when the pattern file is unreadable", async () => {
    const root = tempDir();
    writeFile(join(root, "a.txt"), "x\n");
    const patterns = writePatterns(root, TERMS);
    chmodSync(patterns, 0o000);
    const stub = writeStubGitleaks(root);
    const result = await runCli(["scan", "--patterns", patterns, "--gitleaks", stub.command, "--files", "a.txt"], { cwd: root });
    chmodSync(patterns, 0o600);
    expectUnavailable(result);
    expect(result.stdout + result.stderr).not.toContain(patterns);
  });

  it("is unavailable for invalid UTF-8", async () => {
    const outcome = await scanFiles({ "a.txt": "x\n" }, { terms: Uint8Array.from([0x61, 0xff, 0xfe, 0x0a]) });
    expectUnavailable(outcome.result);
  });

  it("is unavailable when the file has only comments and blank lines", async () => {
    const outcome = await scanFiles({ "a.txt": `${TERM}\n` }, { terms: "# only a comment\n\n   \n# another\n" });
    expectUnavailable(outcome.result);
  });

  it("handles CRLF line endings and a byte-order mark", async () => {
    const terms = `\uFEFF${TERM}\r\n# comment\r\n\r\n  second-synthetic-term  \r\n`;
    const outcome = await scanFiles({ "a.txt": `${TERM}\nsecond-synthetic-term\n` }, { terms });
    expectBlocked(outcome, ["a.txt:1", "a.txt:2"]);
  });

  it("decodes content with a UTF-16 byte-order mark before checking it", async () => {
    const littleEndian = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`first\r\nsecond ${TERM}\r\n`, "utf16le")]);
    const bigEndian = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`${forms.signedOff}: x\n`, "utf16le").swap16()]);
    expectBlocked(await scanFiles({ "le.txt": littleEndian, "be.txt": bigEndian }), ["be.txt:1", "le.txt:2"]);
  });

  it("matches regular-expression characters literally", async () => {
    const terms = "syn.thetic*(x)\n";
    expectClean(await scanFiles({ "a.txt": "synXthetic(x)\nsyn.theticccc(x)\n" }, { terms }));
    expectBlocked(await scanFiles({ "a.txt": "ok\nsee syn.thetic*(x) here\n" }, { terms }), ["a.txt:2"]);
  });

  it("ignores case and Unicode normalisation differences", async () => {
    const terms = "Synthetic-Caf\u00e9\n";
    const outcome = await scanFiles({ "a.txt": "x\nSYNTHETIC-CAFE\u0301 here\n" }, { terms });
    expectBlocked(outcome, ["a.txt:2"]);
  });

  it("finds a term wrapped across two lines and reports the starting line", async () => {
    const terms = "synthetic   wrapped term\n";
    const outcome = await scanFiles({ "doc.md": "one\ntwo\nthis synthetic\n   wrapped\tterm continues\n" }, { terms });
    expectBlocked(outcome, ["doc.md:3"]);
  });

  it("never prints the term or the pattern file path", async () => {
    const outcome = await scanFiles({ "a.txt": `${TERM}\n` });
    expectBlocked(outcome, ["a.txt:1"]);
    const all = outcome.result.stdout + outcome.result.stderr;
    expect(all).not.toContain(TERM);
    expect(all).not.toContain(outcome.patterns);
    expect(all.toLowerCase()).not.toContain("pattern");
  });
});

describe("PUB-02 scanner CLI: attribution", () => {
  const flagged: [string, string][] = [
    ["trailer", `${forms.coauthored}: Synthetic Person <p@example.invalid>`],
    ["comment trailer", `// ${forms.coauthored}: x`],
    ["quoted trailer", `> ${forms.signedOff}: x`],
    ["reviewed trailer with spaced colon", `- ${forms.reviewedTrailer} : x`],
    ["acked trailer", `  ${forms.acked.toUpperCase()}: x`],
    ["helped trailer", `# ${forms.helped}: x`],
    ["suggested trailer", `/* ${forms.suggested}: x`],
    ["generated-line, with", `${forms.generatedWith} some tool`],
    ["generated-line, by, after emoji", `\u2728 ${forms.generatedBy} a tool`],
    ["generated-line after a long prefix run", `${"+>\u2728".repeat(2000)} ${forms.generatedBy} a tool`],
    ["generated in html comment", `<!-- ${forms.generatedWith} a tool -->`],
    ["robot emoji", `plain text ${forms.robot} mid-line`],
    ["edited note", `This page was ${forms.editedNote.replace(" ", "   ")} someone.`],
    ["reviewed note", `Text ${forms.reviewedNote} a person`],
    ["requested note", `${forms.requestedNote.toUpperCase()} someone`],
    ["approved note", `it was ${forms.approvedNote} them`],
    ["behalf note", `posted ${forms.behalfNote} a team`],
    ["author tag", ` * ${forms.authorTag} someone`],
  ];
  for (const [name, line] of flagged) {
    it(`flags ${name}`, async () => {
      const outcome = await scanFiles({ "notes.md": `first line\n${line}\n` });
      expectBlocked(outcome, ["notes.md:2"]);
      expect(outcome.result.stdout).not.toContain(line.trim());
    });
  }

  it("flags a note whose words are split by a line break", async () => {
    const [first, second] = forms.approvedNote.split(" ");
    expectBlocked(await scanFiles({ "a.md": `x\nwas ${first ?? ""}\n${second ?? ""} them\n` }), ["a.md:2"]);
  });

  it("does not flag the word per, mid-sentence forms or author without @", async () => {
    const text = [
      "Changes per the specification.",
      `Commits must not carry the \`${forms.coauthored}\` trailer.`,
      `Use no \`${forms.authorTag}\` tags in code.`,
      "author: the build",
      "The changes were reviewed carefully by the build.",
      `text with ${forms.reviewedTrailer}: inside a sentence`,
    ].join("\n");
    expectClean(await scanFiles({ "a.md": `${text}\n` }));
  });
});

describe("PUB-02 scanner CLI: exceptions", () => {
  const holderLine = "Copyright (c) 2026 Synthetic Holder";
  const terms = "synthetic holder\nsynthetic-owner\n";
  const license = `MIT License\n\n${holderLine}\n\nPermission is granted.\n`;

  it("exempts the trusted copyright line only inside files named LICENSE", async () => {
    const root = tempDir();
    const trusted = writeFile(join(root, "trusted", "LICENSE"), license);
    const args = ["--license", trusted];
    expectClean(await scanFiles({ LICENSE: license, "docs/LICENSE": license }, { terms, args }));
    expectBlocked(await scanFiles({ NOTICE: license }, { terms, args }), ["NOTICE:3"]);
    expectBlocked(await scanFiles({ "LICENSE.md": license }, { terms, args }), ["LICENSE.md:3"]);
    const altered = license.replace("2026", "2027");
    expectBlocked(await scanFiles({ LICENSE: altered }, { terms, args }), ["LICENSE:3"]);
    expectBlocked(await scanFiles({ LICENSE: license }, { terms }), ["LICENSE:3"]);
  });

  it("exempts a CRLF copy of the trusted line", async () => {
    const root = tempDir();
    const trusted = writeFile(join(root, "trusted", "LICENSE"), license.replaceAll("\n", "\r\n"));
    expectClean(await scanFiles({ LICENSE: license }, { terms, args: ["--license", trusted] }));
  });

  it("never exempts text blobs", async () => {
    const root = tempDir();
    const trusted = writeFile(join(root, "trusted", "LICENSE"), license);
    const text = writeFile(join(root, "LICENSE"), license);
    const outcome = await scanFiles({ "a.txt": "x\n" }, { terms, args: ["--license", trusted, "--text", `LICENSE=${text}`] });
    expectBlocked(outcome, ["LICENSE:3"]);
  });

  it("trusts the LICENSE at the range base, not the candidate's", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { LICENSE: license }, "chore: licence\n");
    const changed = license.replace(holderLine, "Copyright (c) 2026 Synthetic Holder and others");
    commit(repo, { LICENSE: changed, "sub/LICENSE": license }, "chore: change licence\n");
    const patterns = writePatterns(root, terms);
    const stub = writeStubGitleaks(root);
    const result = await runCli(["scan", "--patterns", patterns, "--gitleaks", stub.command, "--range", `${base}..HEAD`], { cwd: repo });
    expect(outputLines(result)).toEqual(["blocked", "LICENSE:3"]);
  });

  it("exempts each repository URL form", async () => {
    const urls = [
      "https://github.com/synthetic-owner/synthetic-repo",
      "https://github.com/Synthetic-Owner/Synthetic-Repo.git",
      "git@github.com:synthetic-owner/synthetic-repo.git",
      "See github.com/synthetic-owner/synthetic-repo.",
      "https://github.com/synthetic-owner/synthetic-repo/pull/12",
      "(github.com/synthetic-owner/synthetic-repo)",
    ];
    const outcome = await scanFiles({ "a.md": `${urls.join("\n")}\n` }, { terms, args: ["--repository", "synthetic-owner/synthetic-repo"] });
    expectClean(outcome);
  });

  it("blocks other forms and the owner name on its own", async () => {
    const lines = [
      "github.com/synthetic-owner/synthetic-repo-private",
      "https://github.com/synthetic-owner/synthetic-repo2",
      "https://github.com/synthetic-owner/other-repo",
      "gist.github.com/synthetic-owner/synthetic-repo",
      "contact synthetic-owner directly",
      "git@github.com:synthetic-owner/synthetic-repo",
    ];
    const outcome = await scanFiles({ "a.md": `${lines.join("\n")}\n` }, { terms, args: ["--repository", "synthetic-owner/synthetic-repo"] });
    expectBlocked(outcome, ["a.md:1", "a.md:2", "a.md:3", "a.md:4", "a.md:5", "a.md:6"]);
  });

  it("gives no URL exception without --repository", async () => {
    const outcome = await scanFiles({ "a.md": "https://github.com/synthetic-owner/synthetic-repo\n" }, { terms });
    expectBlocked(outcome, ["a.md:1"]);
  });
});

describe("PUB-02 scanner CLI: range mode", () => {
  async function scanRange(repo: string, range: string, root: string, terms = TERMS): Promise<RunResult> {
    const patterns = writePatterns(root, terms);
    const stub = writeStubGitleaks(root);
    return runCli(["scan", "--patterns", patterns, "--gitleaks", stub.command, "--range", range], { cwd: repo });
  }

  it("finds a term added by one commit and removed by a later one", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    commit(repo, { "notes/b.txt": `one\ntwo ${TERM}\n` }, "feat: add\n");
    commit(repo, { "notes/b.txt": null }, "fix: remove\n");
    const result = await scanRange(repo, `${base}..HEAD`, root);
    expect(outputLines(result)).toEqual(["blocked", "notes/b.txt:2"]);
  });

  it("reports messages and trailers as commit locations", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    const first = commit(repo, { "b.txt": "b\n" }, `feat: add b\n\nMentions ${TERM} here.\n`);
    const second = commit(repo, { "c.txt": "c\n" }, `feat: add c\n\nBody.\n\n${forms.coauthored}: x <x@example.invalid>\n`);
    const result = await scanRange(repo, `${base}..HEAD`, root);
    const expected = [`commit-${short(first)}:3`, `commit-${short(second)}:5`].sort();
    expect(outputLines(result)).toEqual(["blocked", ...expected]);
  });

  it("does not scan the author and committer fields", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    commit(repo, { "b.txt": "b\n" }, "feat: add b\n", {
      GIT_AUTHOR_NAME: TERM,
      GIT_AUTHOR_EMAIL: `${TERM}@example.invalid`,
      GIT_COMMITTER_NAME: TERM,
      GIT_COMMITTER_EMAIL: `${TERM}@example.invalid`,
    });
    const result = await scanRange(repo, `${base}..HEAD`, root);
    expect(result.stdout).toBe("clean\n");
  });

  it("scans commit headers other than tree, parent, author and committer after the message lines", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const identity = "synthetic <synthetic@example.invalid> 1700000000 +0000";
    const object = writeFile(
      join(root, "commit.txt"),
      `tree ${tree}\nparent ${base}\nauthor ${identity}\ncommitter ${identity}\nx-note plain\nx-hidden first\n continued ${TERM}\n\nfeat: innocent\n`,
    );
    const head = git(repo, ["hash-object", "-t", "commit", "-w", object]);
    git(repo, ["update-ref", "refs/heads/main", head]);
    const result = await scanRange(repo, `${base}..${head}`, root);
    expect(outputLines(result)).toEqual(["blocked", `commit-${short(head)}:4`]);
  });

  it("ignores replace refs and grafts in the scanned repository", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    const bad = commit(repo, { "b.txt": `${TERM}\n` }, "feat: add\n");
    git(repo, ["reset", "-q", "--hard", base]);
    const good = commit(repo, { "c.txt": "c\n" }, "feat: other\n");
    git(repo, ["replace", bad, good]);
    expect(outputLines(await scanRange(repo, `${base}..${bad}`, root))).toEqual(["blocked", "b.txt:1"]);
    git(repo, ["replace", "-d", bad]);

    git(repo, ["reset", "-q", "--hard", bad]);
    const head = commit(repo, { "d.txt": "d\n" }, "feat: later\n");
    git(repo, ["reset", "-q", "--hard", base]);
    const excluded = commit(repo, { "b.txt": `${TERM}\n`, "c.txt": "c\n" }, "feat: excluded\n");
    writeFile(join(repo, ".git", "info", "grafts"), `${head} ${excluded}\n`);
    expect(outputLines(await scanRange(repo, `${excluded}..${head}`, root))).toEqual(["blocked", "b.txt:1"]);
  });

  it("reports a matching path by its path-list position and never prints it", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    const head = commit(
      repo,
      { "a.txt": "changed\n", [`docs/${TERM}.md`]: `title\n${forms.signedOff}: x\n`, "z.txt": `${forms.generatedWith} x\n` },
      "docs: add\n",
    );
    const result = await scanRange(repo, `${base}..HEAD`, root);
    // The sorted list is a.txt, docs, docs/<term>.md and z.txt.
    expect(outputLines(result)).toEqual(["blocked", `paths-${short(head)}:3`, "z.txt:1"]);
    for (const line of outputLines(result)) expect(line).not.toContain(TERM);
  });

  it("reports violations in a file whose path has a line break by its path-list position only", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    const head = commit(repo, { "first-part\nsecond-part.md": `ok\n${TERM}\n` }, "docs: add\n");
    const result = await scanRange(repo, `${base}..HEAD`, root);
    expect(outputLines(result)).toEqual(["blocked", `paths-${short(head)}:1`]);
    for (const line of result.stdout.split("\n").concat(result.stderr.split("\n"))) {
      expect(line).not.toContain("first-part");
      expect(line).not.toContain("second-part");
    }
  });

  it("lists a directory entry whose subtree holds no files", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    const empty = execFileSync("git", ["hash-object", "-t", "tree", "-w", "--stdin"], { cwd: repo, input: "" }).toString().trim();
    const listing = `${git(repo, ["ls-tree", "HEAD"])}\n040000 tree ${empty}\t${TERM}-dir\n`;
    const tree = execFileSync("git", ["mktree"], { cwd: repo, input: listing }).toString().trim();
    const head = git(repo, ["commit-tree", tree, "-p", base, "-m", "chore: empty directory"]);
    const result = await scanRange(repo, `${base}..${head}`, root);
    expect(outputLines(result)).toEqual(["blocked", `paths-${short(head)}:1`]);
  });

  it("scans repeated tree, parent, author and committer headers and continuations after the committer", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const identity = "synthetic <synthetic@example.invalid> 1700000000 +0000";
    const tails = [
      `committer ${identity}\ncommitter ${TERM} <x@example.invalid> 1 +0000\n`,
      `committer ${identity}\nauthor ${TERM} <x@example.invalid> 1 +0000\n`,
      `committer ${identity}\n ${TERM}\n`,
      `committer ${identity}\nparent ${TERM}\n`,
      `committer ${identity}\ntree ${TERM}\n`,
    ];
    for (const [index, tail] of tails.entries()) {
      const object = writeFile(join(root, `commit-${String(index)}.txt`), `tree ${tree}\nparent ${base}\nauthor ${identity}\n${tail}\nfeat: innocent\n`);
      const head = git(repo, ["hash-object", "--literally", "-t", "commit", "-w", object]);
      const result = await scanRange(repo, `${base}..${head}`, root);
      expect(outputLines(result), tail).toEqual(["blocked", `commit-${short(head)}:2`]);
    }
  });

  it("scans binary content and symlink targets but not deletions", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "old.txt": `${TERM}\n` }, "chore: base\n");
    const binary = Buffer.concat([Buffer.from([0, 1, 2, 0xff, 0x0a]), Buffer.from(`${TERM}\n`)]);
    commit(repo, { "bin/data.bin": binary, "old.txt": null }, "feat: binary\n");
    symlinkSync(`../${TERM}-target`, join(repo, "link"));
    commit(repo, {}, "feat: link\n");
    const result = await scanRange(repo, `${base}..HEAD`, root);
    expect(outputLines(result)).toEqual(["blocked", "bin/data.bin:2", "link:1"]);
  });

  it("lists a submodule path without content", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    git(repo, ["update-index", "--add", "--cacheinfo", `160000,${base},vendor/${TERM}`]);
    git(repo, ["commit", "-q", "--no-verify", "-m", "chore: submodule"]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    const result = await scanRange(repo, `${base}..HEAD`, root);
    // The sorted list is vendor and vendor/<term>.
    expect(outputLines(result)).toEqual(["blocked", `paths-${short(head)}:2`]);
  });

  it("is unavailable for an unknown revision", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    expectUnavailable(await scanRange(repo, "0000000000000000000000000000000000000001..HEAD", root));
  });
});

describe("PUB-02 scanner CLI: gitleaks", () => {
  it("maps a finding to its location and never prints the secret or raw output", async () => {
    const outcome = await scanFiles({ "src/app.ts": `a\nb\nconst key = "${STUB_LEAK_MARKER}-value";\n` });
    expectBlocked(outcome, ["src/app.ts:3"]);
    const all = outcome.result.stdout + outcome.result.stderr;
    expect(all).not.toContain(STUB_LEAK_MARKER);
    expect(all).not.toContain("stub raw output");
  });

  it("maps findings in commit messages and text blobs", async () => {
    const root = tempDir();
    const repo = initRepo(join(root, "repo"));
    const base = commit(repo, { "a.txt": "base\n" }, "chore: base\n");
    const head = commit(repo, { "b.txt": "b\n" }, `feat: b\n\n${STUB_LEAK_MARKER}\n`);
    const text = writeFile(join(root, "comment.md"), `hello\n\n${STUB_LEAK_MARKER}\n`);
    const patterns = writePatterns(root, TERMS);
    const stub = writeStubGitleaks(root);
    const result = await runCli(
      ["scan", "--patterns", patterns, "--gitleaks", stub.command, "--range", `${base}..HEAD`, "--text", `pr-comment=${text}`],
      { cwd: repo },
    );
    expect(outputLines(result)).toEqual(["blocked", `commit-${short(head)}:3`, "pr-comment:3"]);
  });

  it("substitutes {dir} and passes only paths inside it", async () => {
    const outcome = await scanFiles({ "a.txt": "x\n", "b/c.txt": "y\n" });
    expectClean(outcome);
    const { existsSync, readFileSync } = await import("node:fs");
    expect(existsSync(outcome.stub.violationMarker)).toBe(false);
    const calls = readFileSync(outcome.stub.callsLog, "utf8");
    expect(calls).toContain('"version"');
    expect(calls).toContain('"dir"');
  });

  it("substitutes {dir} inside a token, as in the Docker volume form", async () => {
    const stub = writeStubGitleaks(tempDir(), { mountArgument: true });
    const outcome = await scanFiles({ "a.txt": `${STUB_LEAK_MARKER}\n` }, { stub });
    const { existsSync } = await import("node:fs");
    expect(existsSync(stub.violationMarker)).toBe(false);
    expectBlocked(outcome, ["a.txt:1"]);
  });

  it("finds a secret whose repository path gitleaks would allowlist", async () => {
    const stub = writeStubGitleaks(tempDir(), { skipPaths: String.raw`(^|/)node_modules/|\.png$` });
    const outcome = await scanFiles({ "node_modules/x.js": `${STUB_LEAK_MARKER}\n`, "img/a.png": `x\n${STUB_LEAK_MARKER}\n` }, { stub });
    expectBlocked(outcome, ["img/a.png:2", "node_modules/x.js:1"]);
  });

  it("is unavailable when gitleaks cannot start", async () => {
    const root = tempDir();
    const stub: StubGitleaks = { command: join(root, "missing-gitleaks"), violationMarker: "", callsLog: "" };
    expectUnavailable((await scanFiles({ "a.txt": "x\n" }, { stub })).result);
  });

  it("is unavailable when gitleaks reports a different version", async () => {
    const stub = writeStubGitleaks(tempDir(), { version: "8.0.0" });
    expectUnavailable((await scanFiles({ "a.txt": "x\n" }, { stub })).result);
  });

  it("is unavailable for an unexpected exit status", async () => {
    const stub = writeStubGitleaks(tempDir(), { exitStatus: 5 });
    expectUnavailable((await scanFiles({ "a.txt": "x\n" }, { stub })).result);
  });

  it("is unavailable for the generic error exit status", async () => {
    const stub = writeStubGitleaks(tempDir(), { exitStatus: 1 });
    expectUnavailable((await scanFiles({ "a.txt": "x\n" }, { stub })).result);
  });

  it("is unavailable for an unparseable or missing report", async () => {
    const unparseable = writeStubGitleaks(tempDir(), { report: "unparseable" });
    expectUnavailable((await scanFiles({ "a.txt": "x\n" }, { stub: unparseable })).result);
    const missing = writeStubGitleaks(tempDir(), { report: "missing" });
    expectUnavailable((await scanFiles({ "a.txt": "x\n" }, { stub: missing })).result);
  });
});

describe("PUB-02 scanner CLI: review regressions", () => {
  it("scans long runs of prefix characters in linear time", async () => {
    const root = tempDir();
    const work = join(root, "work");
    const lines = ["+>".repeat(5000) + "x", "✨".repeat(10_000) + "x", "<".repeat(10_000) + "x", "+".repeat(10_000) + "x"];
    writeFile(join(work, "long.txt"), `${lines.join("\n")}\n`);
    const patterns = writePatterns(root, TERMS);
    const stub = writeStubGitleaks(root);
    const started = Date.now();
    const result = await run(process.execPath, [cliPath, "scan", "--patterns", patterns, "--gitleaks", stub.command, "--files", "long.txt"], {
      cwd: work,
      env: cleanEnv(),
      timeoutMs: 15_000,
    });
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("clean\n");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("reports violations in a file whose path matches by its files-mode path-list position", async () => {
    const outcome = await scanFiles({ [`docs/${TERM}.md`]: `title\n${forms.signedOff}: x\n`, "z.txt": `${forms.generatedWith} x\n` });
    expectBlocked(outcome, ["paths:1", "z.txt:1"]);
    for (const line of (outcome.result.stdout + outcome.result.stderr).split("\n")) expect(line).not.toContain(TERM);
  });

  it("keeps the author tag form out of the rule source", () => {
    const source = readFileSync(join(cliPath, "..", "checks.ts"), "utf8");
    expect(source).not.toContain(["@", "author"].join(""));
  });
});
