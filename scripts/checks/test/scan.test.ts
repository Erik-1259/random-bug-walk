import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checksDir,
  commitAll,
  initRepository,
  lines,
  makeTempDir,
  runScript,
  writeFiles,
  type RunResult,
} from "./helpers.ts";

const standIn = join(checksDir, "test", "fixtures", "scanner-stand-in.ts");
const syntheticTerm = "synthetic-canary-term";
const zeroSha = "0".repeat(40);

let repo = "";
let baseSha = "";
let middleSha = "";
let headSha = "";
// Paths introduced in the range whose names would start or embed a workflow command.
const commandPaths = [" ::error::spoofed", "a##[warning]b"];

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "synthetic-scan-repo-"));
  initRepository(repo);
  writeFiles(repo, { "README.md": "synthetic base\n" });
  baseSha = commitAll(repo, "docs: synthetic base");
  writeFiles(repo, { "README.md": "synthetic base\nchanged\n", "docs/nested/guide.md": "synthetic change\n" });
  middleSha = commitAll(repo, "docs: synthetic change");
  writeFiles(repo, Object.fromEntries(commandPaths.map((path) => [path, "synthetic\n"])));
  headSha = commitAll(repo, "docs: synthetic names");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

interface Scenario {
  mode?: "public-safety" | "names-attribution";
  event?: string;
  payload?: unknown;
  patterns?: string | null;
  preset?: { stdout?: string; stderr?: string; exit?: number; crash?: boolean; sleepMs?: number };
  scanner?: string;
  extraArgs?: readonly string[];
}

interface ScenarioResult extends RunResult {
  record: { args: string[]; texts: Record<string, string> } | undefined;
}

function pullRequestPayload(title: string, body: string | null): unknown {
  return {
    pull_request: {
      number: 7,
      title,
      body,
      base: { sha: baseSha },
      head: { sha: headSha },
    },
  };
}

function runWrapper(scenario: Scenario): ScenarioResult {
  const work = makeTempDir("scan-work");
  const files: Record<string, string> = {
    "event.json": JSON.stringify(scenario.payload ?? pullRequestPayload("synthetic title", "synthetic body")),
  };
  if (scenario.patterns !== null) {
    files["patterns.txt"] = scenario.patterns ?? `# synthetic list\n${syntheticTerm}\n`;
  }
  if (scenario.preset !== undefined) {
    files["preset.json"] = JSON.stringify(scenario.preset);
  }
  writeFiles(work, files);
  const recordPath = join(work, "record.json");
  const env: NodeJS.ProcessEnv = {
    GITHUB_EVENT_NAME: scenario.event ?? "pull_request",
    GITHUB_EVENT_PATH: join(work, "event.json"),
    SYNTHETIC_STANDIN_RECORD: recordPath,
  };
  if (scenario.preset !== undefined) {
    env.SYNTHETIC_STANDIN_PRESET = join(work, "preset.json");
  }
  const result = runScript(
    "scan.ts",
    [
      "--mode",
      scenario.mode ?? "public-safety",
      "--scanner",
      scenario.scanner ?? standIn,
      "--patterns",
      join(work, "patterns.txt"),
      "--gitleaks",
      "synthetic-gitleaks-command",
      "--repository",
      "synthetic-owner/synthetic-repo",
      ...(scenario.extraArgs ?? []),
    ],
    { cwd: repo, env },
  );
  const record = existsSync(recordPath)
    ? (JSON.parse(readFileSync(recordPath, "utf8")) as ScenarioResult["record"])
    : undefined;
  return { ...result, record };
}

function expectNoLeak(result: RunResult): void {
  expect(result.stdout.toLowerCase()).not.toContain(syntheticTerm);
  expect(result.stderr.toLowerCase()).not.toContain(syntheticTerm);
}

describe("scan wrapper outcomes", () => {
  it("passes on a well-formed clean result", () => {
    const result = runWrapper({ preset: { stdout: "clean\n", exit: 0 } });

    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toEqual(["public-safety: clean", "dropped 0 scanner output lines"]);
  });

  it("fails on blocked and lists every location form", () => {
    const locations = [
      "README.md:3",
      "docs/nested/guide.md:12",
      `commit-${headSha.slice(0, 12)}:4`,
      `paths-${middleSha.slice(0, 12)}:1`,
      "pr-title:1",
      "pr-body:2",
    ];
    const result = runWrapper({
      mode: "names-attribution",
      preset: { stdout: `blocked\n${locations.join("\n")}\n`, exit: 1 },
    });

    expect(result.status).toBe(1);
    expect(lines(result.stdout)).toEqual([
      "names-attribution: blocked",
      ...locations,
      "dropped 0 scanner output lines",
    ]);
  });

  it("drops any other scanner output, stderr included, and counts the dropped lines", () => {
    const result = runWrapper({
      preset: {
        stdout: `blocked\nREADME.md:1\nmatched ${syntheticTerm} in README.md\nREADME.md:x\n/abs/path:1\n../up.md:2\n`,
        stderr: `debug: pattern ${syntheticTerm}\nsecond stderr line\n`,
        exit: 1,
      },
    });

    expect(result.status).toBe(1);
    expect(lines(result.stdout)).toEqual(["public-safety: blocked", "README.md:1", "dropped 6 scanner output lines"]);
    expectNoLeak(result);
  });

  it("drops location-shaped lines that are not a path or commit introduced in the range", () => {
    const result = runWrapper({
      preset: {
        stdout: [
          "blocked",
          "README.md:1",
          `${syntheticTerm}:1`,
          `matched ${syntheticTerm} in README.md:3`,
          "not-introduced.md:2",
          "commit-0123456789ab:4",
          "paths-ba9876543210:1",
          `commit-${baseSha.slice(0, 12)}:1`,
          "",
        ].join("\n"),
        exit: 1,
      },
    });

    expect(result.status).toBe(1);
    expect(lines(result.stdout)).toEqual(["public-safety: blocked", "README.md:1", "dropped 6 scanner output lines"]);
    expectNoLeak(result);
  });

  it("does not let a location line start a workflow command", () => {
    const result = runWrapper({
      preset: {
        stdout: ["blocked", "::warning::x:1", ...commandPaths.map((path) => `${path}:1`), "README.md :1", "README.md:2", ""].join("\n"),
        exit: 1,
      },
    });

    expect(lines(result.stdout)).toEqual(["public-safety: blocked", "README.md:2", "dropped 4 scanner output lines"]);
  });

  it.each([
    ["the scanner reports unavailable", { stdout: "unavailable\n", stderr: "category: synthetic\n", exit: 2 }],
    ["clean with a failing exit code", { stdout: "clean\n", exit: 1 }],
    ["blocked with a zero exit code", { stdout: "blocked\nREADME.md:1\n", exit: 0 }],
    ["an unexpected exit code", { stdout: "clean\n", exit: 3 }],
    ["unknown output", { stdout: "ok\n", exit: 0 }],
    ["empty output", { stdout: "", exit: 0 }],
    ["clean followed by extra output", { stdout: "clean\nREADME.md:1\n", exit: 0 }],
    ["blocked without any location", { stdout: `blocked\n${syntheticTerm}\n`, exit: 1 }],
    ["a crash", { stdout: "clean\n", crash: true }],
  ])("fails as unavailable when %s", (_label, preset) => {
    const result = runWrapper({ preset });

    expect(result.status).toBe(2);
    expect(lines(result.stdout)[0]).toMatch(/^public-safety: unavailable \(.+\)$/);
    expectNoLeak(result);
  });

  it("fails as unavailable when the scanner times out", () => {
    const result = runWrapper({ preset: { stdout: "clean\n", sleepMs: 5000 }, extraArgs: ["--timeout-ms", "300"] });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("public-safety: unavailable (scanner timed out)");
  });

  it("fails as unavailable when the scanner CLI is missing", () => {
    const result = runWrapper({ scanner: join(repo, "tools", "publication", "src", "cli.ts") });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("public-safety: unavailable (scanner missing)");
  });

  it.each([
    ["absent", null],
    ["empty", ""],
    ["comment-only", "# synthetic comment\n\n   \n# another\n"],
  ])("fails as pattern list unavailable without scanning when the list is %s", (_label, patterns) => {
    const result = runWrapper({ patterns, preset: { stdout: "clean\n", exit: 0 } });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("public-safety: unavailable (pattern list unavailable)");
    expect(result.record).toBeUndefined();
  });
});

describe("scan wrapper inputs", () => {
  it("scans the pull request range with the pattern file, repository and gitleaks command", () => {
    const result = runWrapper({ preset: { stdout: "clean\n", exit: 0 } });

    expect(result.status).toBe(0);
    const args = result.record?.args ?? [];
    expect(args[0]).toBe("scan");
    expect(args).toEqual(
      expect.arrayContaining(["--range", `${baseSha}..${headSha}`, "--repository", "synthetic-owner/synthetic-repo"]),
    );
    expect(args).toEqual(expect.arrayContaining(["--gitleaks", "synthetic-gitleaks-command"]));
    expect(args[args.indexOf("--patterns") + 1]).toMatch(/patterns\.txt$/);
    expect(args).not.toContain("--text");
  });

  it("adds the pull request title and body as text blobs in names-attribution mode", () => {
    const result = runWrapper({
      mode: "names-attribution",
      payload: pullRequestPayload("synthetic: title", "first line\nsecond line\n"),
      preset: { stdout: "clean\n", exit: 0 },
    });

    expect(result.status).toBe(0);
    expect(result.record?.texts).toEqual({ "pr-title": "synthetic: title", "pr-body": "first line\nsecond line\n" });
    expect(result.record?.args).toEqual(expect.arrayContaining(["--range", `${baseSha}..${headSha}`]));
  });

  it("treats a null pull request body as an empty blob", () => {
    const result = runWrapper({
      mode: "names-attribution",
      payload: pullRequestPayload("synthetic title", null),
      preset: { stdout: "clean\n", exit: 0 },
    });

    expect(result.record?.texts).toEqual({ "pr-title": "synthetic title", "pr-body": "" });
  });

  it("removes its temporary text files after the scan", () => {
    const result = runWrapper({ mode: "names-attribution", preset: { stdout: "clean\n", exit: 0 } });

    const textFiles = (result.record?.args ?? []).filter((arg) => arg.startsWith("pr-")).map((arg) => arg.split("=")[1]);
    expect(textFiles).toHaveLength(2);
    for (const file of textFiles) {
      expect(existsSync(file ?? "")).toBe(false);
    }
  });

  it("scans the push range from before to after", () => {
    const result = runWrapper({
      event: "push",
      payload: { before: baseSha, after: headSha },
      mode: "names-attribution",
      preset: { stdout: "clean\n", exit: 0 },
    });

    expect(result.status).toBe(0);
    expect(result.record?.args).toEqual(expect.arrayContaining(["--range", `${baseSha}..${headSha}`]));
    expect(result.record?.args).not.toContain("--text");
  });

  it("fails a push with an all-zero before as unsupported without scanning", () => {
    const result = runWrapper({
      event: "push",
      payload: { before: zeroSha, after: headSha },
      preset: { stdout: "clean\n", exit: 0 },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("public-safety: unsupported (push without a previous commit)");
    expect(result.record).toBeUndefined();
  });

  it("fails a push whose before commit is not in the checkout as unsupported", () => {
    const result = runWrapper({
      event: "push",
      payload: { before: "1".repeat(40), after: headSha },
      preset: { stdout: "clean\n", exit: 0 },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("public-safety: unsupported (commit not in checkout)");
    expect(result.record).toBeUndefined();
  });

  it.each([["workflow_dispatch"], ["pull_request_target"], ["schedule"]])(
    "fails the %s event as unsupported",
    (event) => {
      const result = runWrapper({ event, preset: { stdout: "clean\n", exit: 0 } });

      expect(result.status).toBe(2);
      expect(result.stdout).toContain("public-safety: unsupported (event not supported)");
      expect(result.record).toBeUndefined();
    },
  );

  it("fails as unavailable when the event payload has no valid SHAs", () => {
    const result = runWrapper({
      payload: { pull_request: { title: "t", body: null, base: { sha: "main" }, head: { sha: headSha } } },
      preset: { stdout: "clean\n", exit: 0 },
    });

    expect(result.status).toBe(2);
    expect(result.record).toBeUndefined();
  });
});

describe("scan wrapper with the stand-in's literal scan", () => {
  it("blocks a commit that adds the term without printing the term", () => {
    const dir = makeTempDir("scan-e2e");
    initRepository(dir);
    writeFiles(dir, { "README.md": "synthetic base\n" });
    const base = commitAll(dir, "docs: synthetic base");
    writeFiles(dir, { "docs/leak.md": `line one\nmentions ${syntheticTerm}\n` });
    const head = commitAll(dir, "docs: synthetic change");
    const work = makeTempDir("scan-e2e-work");
    writeFiles(work, {
      "event.json": JSON.stringify({ before: base, after: head }),
      "patterns.txt": `${syntheticTerm}\n`,
    });

    const result = runScript(
      "scan.ts",
      ["--mode", "public-safety", "--scanner", standIn, "--patterns", join(work, "patterns.txt")],
      { cwd: dir, env: { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: join(work, "event.json") } },
    );

    expect(result.status).toBe(1);
    expect(lines(result.stdout)).toEqual(["public-safety: blocked", "docs/leak.md:2", "dropped 0 scanner output lines"]);
    expectNoLeak(result);
  });
});
