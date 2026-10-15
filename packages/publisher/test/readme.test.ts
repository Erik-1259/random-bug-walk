import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPolicy, parseCanonical } from "@rbw/schema";
import { runCli, type CliDeps, type CliResult } from "../src/cli.ts";
import { runProcess, type ProcessResult, type ProcessRunner } from "../src/process.ts";
import {
  BASE_URI,
  FORBIDDEN_TERM,
  GITHUB_REPOSITORY,
  OTHER_ROOT_ID,
  PROJECT_ID,
  REPOSITORY_URL,
  ROOT_ID,
  SSH_REMOTE,
  commitCount,
  createWorld,
  events,
  git,
  gitBytes,
  harness,
  headCommit,
  sha256,
  storeObjects,
  tempDir,
  write,
  writeFakeScanner,
  type Harness,
  type World,
} from "./support.ts";

const RELEASE_ID = "00000000-0000-4000-8000-000000000601";
const REAL_BASE_URI = "https://synthetic-store.example.invalid/test-prefix/";
const TEXT = "# Synthetic results\n\nThis synthetic repository holds synthetic records.\n";
const MESSAGE = "chore(readme): publish";

/** Records already on the branch: a run and a release, as the publisher writes them. */
const RECORDS: Record<string, string> = {
  [`runs/${ROOT_ID}/manifest.json`]: '{"synthetic":"manifest"}\n',
  [`runs/${ROOT_ID}/report.md`]: "# Synthetic report\n",
  [`releases/${RELEASE_ID}/release.json`]: '{"synthetic":"release"}\n',
};

const rejected: ProcessResult = { code: 1, spawnFailed: false, timedOut: false, stdout: Buffer.alloc(0), stderr: Buffer.from("rejected") };

const isPush = (args: readonly string[]): boolean => args.includes("push");

/** One commit with the given files, pushed to the world's remote by a synthetic author. `prepare` can change the work tree first. */
function seed(world: World, files: Record<string, string>, prepare: (work: string) => void = () => undefined): string {
  const work = tempDir("rbw-publisher-seed-");
  git(work, ["init", "-q", "-b", "main"]);
  for (const [path, content] of Object.entries(files)) write(join(work, path), content);
  prepare(work);
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "chore: seed"]);
  git(work, ["push", "-q", world.remote, "main"]);
  return headCommit(world.remote) ?? "";
}

function writeReadme(world: World, content: string | Uint8Array, name = "README.md"): string {
  return write(join(world.dir, "input", name), content);
}

interface ReadmeOptions {
  state?: string;
  policy?: string;
  remote?: string;
  patterns?: string;
  extra?: string[];
  deps?: Partial<CliDeps>;
}

function readme(world: World, file: string, options: ReadmeOptions = {}): Promise<CliResult> {
  return runCli(
    [
      "readme",
      "--file",
      file,
      "--policy",
      options.policy ?? world.policyFile,
      "--state",
      options.state ?? world.state,
      "--patterns",
      options.patterns ?? world.patterns,
      "--local-remote",
      options.remote ?? world.remote,
      "--local-store",
      world.store,
      "--gitleaks",
      world.gitleaks,
      ...(options.extra ?? []),
    ],
    { env: { PATH: process.env.PATH ?? "", HOME: world.dir }, ...options.deps },
  );
}

/** Points the world's policy at the synthetic GitHub repository and writes an owner-only synthetic deploy key. */
function realSetup(world: World, keyBytes: string | Uint8Array = `${["synthetic", "deploy", "key", "placeholder"].join("-")}\n`): { keyFile: string; policySha256: string } {
  const built = buildPolicy({ projectId: PROJECT_ID, outputRepository: GITHUB_REPOSITORY, publicArtifactBaseUri: REAL_BASE_URI, policyVersion: 1 });
  writeFileSync(world.policyFile, built.bytes);
  const keyFile = write(join(world.dir, "keys", "deploy-key"), keyBytes);
  chmodSync(keyFile, 0o600);
  return { keyFile, policySha256: built.sha256 };
}

/** The readme command in real mode, with fake git and store clients that push to the world's remote. */
function readmeReal(world: World, file: string, keyFile: string, fake: Harness): Promise<CliResult> {
  return runCli(
    [
      "readme",
      "--real",
      "--file",
      file,
      "--policy",
      world.policyFile,
      "--state",
      world.state,
      "--patterns",
      world.patterns,
      "--repository-url",
      GITHUB_REPOSITORY,
      "--artifact-base-uri",
      REAL_BASE_URI,
      "--gitleaks",
      world.gitleaks,
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: world.dir,
        RBW_RESULTS_DEPLOY_KEY_FILE: keyFile,
        BLOB_PUBLIC_STORE_ID: ["synthetic", "store", "placeholder"].join("-"),
        VERCEL_OIDC_TOKEN: ["synthetic", "oidc", "placeholder"].join("-"),
      },
      runner: fake.runner,
      blobClient: fake.blobClient,
      fetch: fake.fetch,
    },
  );
}

interface ReadmeRecordView {
  schema_version: number;
  path: string;
  sha256: string;
  size_bytes: number;
  project_policy_sha256: string;
  branch: string;
  repository: string;
  status: string;
  repository_commit: string | null;
  failure_reason: string | null;
}

function record(result: CliResult): ReadmeRecordView {
  return JSON.parse(result.stdout) as ReadmeRecordView;
}

function storedRecord(state: string): ReadmeRecordView {
  return parseCanonical(readFileSync(join(state, "readme", "record.json"))) as unknown as ReadmeRecordView;
}

function changedPaths(remote: string, commit: string): string[] {
  return git(remote, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).split("\n").filter((line) => line.length > 0);
}

describe("readme", () => {
  it("publishes README.md in one fast-forward commit that touches only README.md and leaves runs/ and releases/ byte-identical", async () => {
    const world = createWorld();
    const base = seed(world, RECORDS);
    const runsTree = git(world.remote, ["rev-parse", `${base}:runs`]);
    const releasesTree = git(world.remote, ["rev-parse", `${base}:releases`]);
    const file = writeReadme(world, TEXT);
    const result = await readme(world, file);
    expect(result.stderr).not.toContain("internal error");
    expect(result.code).toBe(0);
    const commit = headCommit(world.remote) ?? "";
    expect(record(result)).toEqual({
      schema_version: 1,
      path: "README.md",
      sha256: sha256(TEXT),
      size_bytes: Buffer.byteLength(TEXT),
      project_policy_sha256: world.policySha256,
      branch: "main",
      repository: world.remote,
      status: "published",
      repository_commit: commit,
      failure_reason: null,
    });
    expect(commitCount(world.remote)).toBe(2);
    expect(git(world.remote, ["rev-list", "--parents", "-n", "1", commit])).toBe(`${commit} ${base}`);
    expect(changedPaths(world.remote, commit)).toEqual(["README.md"]);
    expect(git(world.remote, ["rev-parse", `${commit}:runs`])).toBe(runsTree);
    expect(git(world.remote, ["rev-parse", `${commit}:releases`])).toBe(releasesTree);
    expect(git(world.remote, ["ls-tree", commit, "README.md"])).toMatch(/^100644 blob [0-9a-f]{40}\tREADME\.md$/);
    expect(gitBytes(world.remote, ["cat-file", "blob", `${commit}:README.md`])).toEqual(readFileSync(file));
    const raw = git(world.remote, ["cat-file", "commit", commit]);
    expect(raw).toMatch(/^author Random Bug Walk <> \d+ \+0000$/m);
    expect(raw).toMatch(/^committer Random Bug Walk <> \d+ \+0000$/m);
    expect(raw.split("\n\n").slice(1).join("\n\n")).toBe(MESSAGE);
    expect(storedRecord(world.state)).toEqual(record(result));
    expect(existsSync(join(world.state, "readme", sha256(TEXT), "limits.json"))).toBe(true);
    expect(storeObjects(world.store)).toEqual([]);
    expect(existsSync(join(world.store, "status"))).toBe(false);
  });

  it("replaces an existing README.md and changes nothing else", async () => {
    const world = createWorld();
    const base = seed(world, { ...RECORDS, "README.md": "# Old synthetic text\n" });
    const result = await readme(world, writeReadme(world, TEXT));
    expect(result.code).toBe(0);
    const commit = headCommit(world.remote) ?? "";
    expect(record(result)).toMatchObject({ status: "published", repository_commit: commit });
    expect(git(world.remote, ["diff-tree", "--no-commit-id", "--name-status", "-r", commit])).toBe("M\tREADME.md");
    expect(git(world.remote, ["rev-parse", `${commit}:runs`])).toBe(git(world.remote, ["rev-parse", `${base}:runs`]));
    expect(git(world.remote, ["rev-parse", `${commit}:releases`])).toBe(git(world.remote, ["rev-parse", `${base}:releases`]));
    expect(git(world.remote, ["cat-file", "blob", `${commit}:README.md`])).toBe(TEXT.trimEnd());
  });

  it("records published without a commit when the branch already holds the same bytes", async () => {
    const world = createWorld();
    seed(world, RECORDS);
    const file = writeReadme(world, TEXT);
    const first = await readme(world, file);
    expect(first.code).toBe(0);
    const commit = headCommit(world.remote);

    // The same state directory prints the stored record and contacts nothing.
    const again = await readme(world, file);
    expect(again.code).toBe(0);
    expect(again.stdout).toBe(first.stdout);
    expect(events(again, "fetch")).toEqual([]);

    // A fresh state directory fetches, finds the same bytes and pushes nothing.
    const freshState = join(tempDir(), "state");
    const fresh = await readme(world, file, { state: freshState });
    expect(fresh.code).toBe(0);
    expect(record(fresh)).toMatchObject({ status: "published", repository_commit: commit });
    expect(events(fresh, "fetch")).toHaveLength(1);
    expect(events(fresh, "commit")).toEqual([]);
    expect(events(fresh, "push")).toEqual([]);
    expect(storedRecord(freshState)).toMatchObject({ status: "published", repository_commit: commit });
    expect(commitCount(world.remote)).toBe(2);

    // Bytes written by an earlier commit count too, with the commit that wrote them.
    const seeded = createWorld();
    const seedCommit = seed(seeded, { ...RECORDS, "README.md": TEXT });
    const found = await readme(seeded, writeReadme(seeded, TEXT));
    expect(found.code).toBe(0);
    expect(record(found)).toMatchObject({ status: "published", repository_commit: seedCommit });
    expect(events(found, "push")).toEqual([]);
    expect(commitCount(seeded.remote)).toBe(1);
  });

  it("blocks a README or commit message that fails the scan, pushes nothing and records the refusal", async () => {
    const world = createWorld();
    seed(world, RECORDS);
    const result = await readme(world, writeReadme(world, `# Synthetic results\n\nA ${FORBIDDEN_TERM} here.\n`));
    expect(result.code).toBe(1);
    expect(record(result)).toMatchObject({ status: "blocked", failure_reason: "scan_blocked", repository_commit: null });
    expect(result.stderr).toMatch(/^README\.md:3$/m);
    expect(result.stderr).not.toContain(FORBIDDEN_TERM);
    expect(events(result, "fetch")).toEqual([]);
    expect(events(result, "push")).toEqual([]);
    expect(storedRecord(world.state)).toMatchObject({ status: "blocked", failure_reason: "scan_blocked" });
    expect(commitCount(world.remote)).toBe(1);

    // The commit message is scanned as well.
    const patterns = write(join(world.dir, "private", "message-patterns.txt"), "# synthetic pattern list\n\nchore(readme)\n");
    const message = await readme(world, writeReadme(world, TEXT), { patterns });
    expect(message.code).toBe(1);
    expect(record(message)).toMatchObject({ status: "blocked", failure_reason: "scan_blocked" });
    expect(message.stderr).toMatch(/^commit-message:1$/m);
    expect(commitCount(world.remote)).toBe(1);
  });

  it("records scan_unavailable when the scanner fails, and pushes nothing", async () => {
    const world = createWorld();
    seed(world, RECORDS);
    const result = await readme(world, writeReadme(world, TEXT), { extra: ["--scanner", writeFakeScanner(world.dir, "exit2")] });
    expect(result.code).toBe(2);
    expect(record(result)).toMatchObject({ status: "failed", failure_reason: "scan_unavailable", repository_commit: null });
    expect(events(result, "fetch")).toEqual([]);
    expect(events(result, "push")).toEqual([]);
    expect(storedRecord(world.state)).toMatchObject({ status: "failed", failure_reason: "scan_unavailable" });
    expect(commitCount(world.remote)).toBe(1);
  });

  it("records repository_unavailable when the fetch fails, makes no commit, and the next call fetches again", async () => {
    const world = createWorld();
    seed(world, RECORDS);
    const failFetch: ProcessRunner = async (call) => (call.command === "git" && call.args.includes("fetch") ? rejected : runProcess(call));
    const file = writeReadme(world, TEXT);
    const result = await readme(world, file, { deps: { runner: failFetch } });
    expect(result.code).toBe(2);
    expect(record(result)).toMatchObject({ status: "failed", failure_reason: "repository_unavailable", repository_commit: null });
    expect(events(result, "fetch")).toHaveLength(1);
    expect(events(result, "commit")).toEqual([]);
    expect(events(result, "push")).toEqual([]);
    expect(storedRecord(world.state)).toMatchObject({ status: "failed", failure_reason: "repository_unavailable" });
    expect(commitCount(world.remote)).toBe(1);

    const retry = await readme(world, file);
    expect(retry.code).toBe(0);
    expect(events(retry, "fetch")).toHaveLength(1);
    expect(record(retry)).toMatchObject({ status: "published", repository_commit: headCommit(world.remote) });
  });

  it("pushes fast-forward only: a branch that moved after the fetch is refused, never overwritten, and the retry builds on it", async () => {
    const world = createWorld();
    seed(world, RECORDS);
    const concurrentFile = `runs/${OTHER_ROOT_ID}/manifest.json`;
    let concurrent = "";
    // Another commit lands on the branch between the fetch and the push.
    const moveFirst: ProcessRunner = async (call) => {
      if (call.command === "git" && isPush(call.args) && concurrent === "") {
        const work = tempDir("rbw-publisher-concurrent-");
        git(world.dir, ["clone", "-q", world.remote, work]);
        write(join(work, concurrentFile), '{"synthetic":"other"}\n');
        git(work, ["add", "-A"]);
        git(work, ["commit", "-q", "-m", "chore: concurrent"]);
        git(work, ["push", "-q", "origin", "main"]);
        concurrent = headCommit(world.remote) ?? "";
      }
      return runProcess(call);
    };
    const file = writeReadme(world, TEXT);
    const first = await readme(world, file, { deps: { runner: moveFirst } });
    expect(first.code).toBe(2);
    expect(record(first)).toMatchObject({ status: "failed", failure_reason: "repository_unavailable", repository_commit: null });
    expect(headCommit(world.remote)).toBe(concurrent);
    expect(git(world.remote, ["ls-tree", "--name-only", concurrent, "README.md"])).toBe("");

    const retry = await readme(world, file);
    expect(retry.code).toBe(0);
    const commit = headCommit(world.remote) ?? "";
    expect(git(world.remote, ["rev-list", "--parents", "-n", "1", commit])).toBe(`${commit} ${concurrent}`);
    expect(changedPaths(world.remote, commit)).toEqual(["README.md"]);
    expect(git(world.remote, ["cat-file", "-t", `${commit}:${concurrentFile}`])).toBe("blob");
  });

  it("refuses repository_conflict when the branch does not exist or README.md is not a regular file", async () => {
    const empty = createWorld();
    const missing = await readme(empty, writeReadme(empty, TEXT));
    expect(missing.code).toBe(2);
    expect(record(missing)).toMatchObject({ status: "failed", failure_reason: "repository_conflict" });
    expect(headCommit(empty.remote)).toBeNull();

    const world = createWorld();
    seed(world, { ...RECORDS, "README.md/nested.md": "# Synthetic nested file\n" });
    const directory = await readme(world, writeReadme(world, TEXT));
    expect(directory.code).toBe(2);
    expect(record(directory)).toMatchObject({ status: "failed", failure_reason: "repository_conflict" });
    expect(events(directory, "push")).toEqual([]);
    expect(commitCount(world.remote)).toBe(1);

    // A symlink (120000), and an executable file (100755) even with the same bytes.
    const linked = createWorld();
    seed(linked, RECORDS, (work) => symlinkSync("runs", join(work, "README.md")));
    const executable = createWorld();
    seed(executable, { ...RECORDS, "README.md": TEXT }, (work) => chmodSync(join(work, "README.md"), 0o755));
    for (const [seeded, mode] of [
      [linked, "120000"],
      [executable, "100755"],
    ] as const) {
      expect(git(seeded.remote, ["ls-tree", "main", "README.md"])).toMatch(new RegExp(`^${mode} `));
      const result = await readme(seeded, writeReadme(seeded, TEXT));
      expect(result.code).toBe(2);
      expect(record(result)).toMatchObject({ status: "failed", failure_reason: "repository_conflict" });
      expect(events(result, "push")).toEqual([]);
      expect(commitCount(seeded.remote)).toBe(1);
    }
  });

  it("refuses a missing, empty, non-UTF-8 or oversized file before contacting anything", async () => {
    const world = createWorld();
    seed(world, RECORDS);
    const folder = join(world.dir, "input", "folder");
    mkdirSync(folder, { recursive: true });
    const cases: [string, string][] = [
      [join(world.dir, "input", "absent.md"), "readme_unreadable"],
      [folder, "readme_unreadable"],
      [writeReadme(world, "", "empty.md"), "readme_empty"],
      [writeReadme(world, Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]), "latin.md"), "readme_not_utf8"],
      [writeReadme(world, "a".repeat(64 * 1024 + 1), "large.md"), "readme_too_large"],
    ];
    // A sparse 2 GiB file, too large for Node to read into one buffer, is refused by its size.
    const huge = writeReadme(world, "", "huge.md");
    truncateSync(huge, 2 ** 31);
    cases.push([huge, "readme_too_large"]);
    for (const [file, code] of cases) {
      const result = await readme(world, file);
      expect(result.code).toBe(4);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`invalid input: ${code}\n`);
      expect(events(result, "fetch")).toEqual([]);
    }
    const noFile = await runCli(["readme", "--policy", world.policyFile, "--state", world.state, "--patterns", world.patterns, "--local-remote", world.remote, "--local-store", world.store], {
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(noFile.code).toBe(4);
    expect(noFile.stderr).toContain("invalid input: missing_file\n");
    expect(existsSync(join(world.state, "readme"))).toBe(false);
    expect(commitCount(world.remote)).toBe(1);

    // The cap itself is allowed.
    const atCap = await readme(world, writeReadme(world, `${"a".repeat(64 * 1024 - 1)}\n`, "cap.md"));
    expect(atCap.code).toBe(0);
    expect(record(atCap)).toMatchObject({ status: "published", size_bytes: 64 * 1024 });
  });

  it("writes README.md and nothing else: the path is fixed, and no option or argument names another", async () => {
    const world = createWorld();
    seed(world, RECORDS);
    const file = write(join(world.dir, "input", "runs", ROOT_ID, "notes.txt"), TEXT);
    for (const extra of [["--path", `runs/${ROOT_ID}/report.md`], ["--target", `releases/${RELEASE_ID}/release.json`], [`releases/${RELEASE_ID}/release.json`]]) {
      const refused = await readme(world, file, { extra });
      expect(refused.code).toBe(4);
      expect(refused.stderr).toContain("invalid input: usage\n");
      expect(refused.stderr).toContain("readme");
    }
    expect(commitCount(world.remote)).toBe(1);

    const result = await readme(world, file);
    expect(result.code).toBe(0);
    const commit = headCommit(world.remote) ?? "";
    expect(changedPaths(world.remote, commit)).toEqual(["README.md"]);
    expect(git(world.remote, ["ls-tree", "-r", "--name-only", commit]).split("\n")).toEqual([...Object.keys(RECORDS), "README.md"].sort());
    expect(git(world.remote, ["cat-file", "blob", `${commit}:README.md`])).toBe(TEXT.trimEnd());
  });

  it("counts limits per README version and stops a version that reached one", async () => {
    const world = createWorld();
    seed(world, RECORDS);
    const rejectPushes: ProcessRunner = async (call) => (call.command === "git" && isPush(call.args) ? rejected : runProcess(call));
    const file = writeReadme(world, TEXT);
    const first = await readme(world, file, { extra: ["--limit-push-attempts", "1"], deps: { runner: rejectPushes } });
    expect(record(first)).toMatchObject({ status: "failed", failure_reason: "repository_unavailable" });

    // The stored limit holds without the flag: the next attempt fetches, then stops before pushing.
    const second = await readme(world, file, { deps: { runner: rejectPushes } });
    expect(second.code).toBe(2);
    expect(record(second)).toMatchObject({ status: "failed", failure_reason: "limit_exceeded" });
    expect(events(second, "push")).toEqual([]);
    const limits = parseCanonical(readFileSync(join(world.state, "readme", sha256(TEXT), "limits.json"))) as unknown as { limits: { pushAttempts: number }; used: { pushAttempts: number; metadataRequests: number } };
    expect(limits.limits.pushAttempts).toBe(1);
    expect(limits.used).toMatchObject({ pushAttempts: 1, metadataRequests: 2 });

    // While the latest record names it, a version that reached a limit contacts nothing again.
    const third = await readme(world, file, { extra: ["--limit-push-attempts", "10"] });
    expect(third.stdout).toBe(second.stdout);
    expect(events(third, "fetch")).toEqual([]);
    expect(commitCount(world.remote)).toBe(1);

    // Other bytes are another version, with their own counters.
    const other = await readme(world, writeReadme(world, `${TEXT}More synthetic text.\n`, "other.md"));
    expect(other.code).toBe(0);
    expect(record(other).status).toBe("published");
    expect(commitCount(world.remote)).toBe(2);
  });

  it("real mode: fetches without credentials, pushes through the deploy key only and touches no store", async () => {
    const world = createWorld();
    const { keyFile, policySha256 } = realSetup(world);
    seed(world, RECORDS);
    const fake = harness(world.remote);
    const result = await readmeReal(world, writeReadme(world, TEXT), keyFile, fake);
    expect(result.stderr).not.toContain("internal error");
    expect(result.code).toBe(0);
    expect(record(result)).toMatchObject({ status: "published", project_policy_sha256: policySha256, repository: SSH_REMOTE });
    const pushes = fake.calls.filter((call) => call.command === "git" && isPush(call.args));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.args).toContain(SSH_REMOTE);
    expect(pushes[0]?.args.some((arg) => arg.startsWith("+") || arg.startsWith("--force"))).toBe(false);
    expect(pushes[0]?.env.GIT_SSH_COMMAND).toContain(`-i '${keyFile}'`);
    for (const call of fake.calls.filter((item) => !isPush(item.args))) expect(Object.values(call.env).join("\n")).not.toContain(keyFile);
    expect(fake.calls.some((call) => call.args.includes("fetch") && call.args.includes(GITHUB_REPOSITORY))).toBe(true);
    expect(fake.puts).toEqual([]);
    expect(fake.fetches).toEqual([]);
    expect(changedPaths(world.remote, headCommit(world.remote) ?? "")).toEqual(["README.md"]);
  });

  it("treats a stored record as final only for its repository: a local rehearsal with the same state does not stand in for the real push", async () => {
    const world = createWorld();
    const { keyFile } = realSetup(world);
    seed(world, RECORDS);
    const rehearsal = createWorld();
    seed(rehearsal, RECORDS);
    const file = writeReadme(world, TEXT);

    // A local rehearsal with the real policy, the same bytes and the same state directory.
    const local = await readme(world, file, { remote: rehearsal.remote });
    expect(local.code).toBe(0);
    expect(record(local)).toMatchObject({ status: "published", repository: rehearsal.remote, repository_commit: headCommit(rehearsal.remote) });
    expect(commitCount(world.remote)).toBe(1);

    // The real run fetches, pushes its own commit and records it.
    const fake = harness(world.remote);
    const real = await readmeReal(world, file, keyFile, fake);
    expect(real.stderr).not.toContain("internal error");
    expect(real.code).toBe(0);
    expect(events(real, "fetch")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.command === "git" && isPush(call.args))).toHaveLength(1);
    expect(commitCount(world.remote)).toBe(2);
    expect(record(real)).toMatchObject({ status: "published", repository: SSH_REMOTE, repository_commit: headCommit(world.remote) });
    expect(storedRecord(world.state)).toEqual(record(real));

    // Another real run with the same state prints that record and contacts nothing.
    const again = harness(world.remote);
    const repeat = await readmeReal(world, file, keyFile, again);
    expect(repeat.code).toBe(0);
    expect(repeat.stdout).toBe(real.stdout);
    expect(again.calls).toEqual([]);
  });

  it("treats a stored record as final only for its policy and branch", async () => {
    const world = createWorld();
    seed(world, RECORDS);
    const file = writeReadme(world, TEXT);
    expect((await readme(world, file)).code).toBe(0);
    const commit = headCommit(world.remote);

    // Another policy fetches once, finds the same bytes and pushes nothing.
    const built = buildPolicy({ projectId: PROJECT_ID, outputRepository: REPOSITORY_URL, publicArtifactBaseUri: BASE_URI, policyVersion: 2 });
    const policy = write(join(world.dir, "private", "policy-2.json"), built.bytes);
    const otherPolicy = await readme(world, file, { policy });
    expect(otherPolicy.code).toBe(0);
    expect(record(otherPolicy)).toMatchObject({ status: "published", project_policy_sha256: built.sha256, repository_commit: commit });
    expect(events(otherPolicy, "fetch")).toHaveLength(1);
    expect(events(otherPolicy, "push")).toEqual([]);

    // Another branch fetches once, and a branch that does not exist is refused.
    const otherBranch = await readme(world, file, { policy, extra: ["--branch", "other"] });
    expect(otherBranch.code).toBe(2);
    expect(record(otherBranch)).toMatchObject({ status: "failed", branch: "other", failure_reason: "repository_conflict" });
    expect(events(otherBranch, "fetch")).toHaveLength(1);
    expect(commitCount(world.remote)).toBe(2);
  });

  it("refuses a file that is the deploy key or a link to it, or lies in the state directory, without reading it", async () => {
    const world = createWorld();
    // Key bytes that are not UTF-8: a refusal that names them would show that the key was read.
    const { keyFile } = realSetup(world, Buffer.from([0x23, 0xff, 0x0a]));
    seed(world, RECORDS);
    mkdirSync(join(world.dir, "input"), { recursive: true });
    const link = join(world.dir, "input", "README.md");
    symlinkSync(keyFile, link);
    for (const file of [keyFile, link]) {
      const fake = harness(world.remote);
      const result = await readmeReal(world, file, keyFile, fake);
      expect(result.code).toBe(4);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("invalid input: deploy_key_location\n");
      expect(fake.calls).toEqual([]);
    }

    const inState = write(join(world.state, "readme", "input.md"), TEXT);
    const state = await readme(world, inState);
    expect(state.code).toBe(4);
    expect(state.stderr).toContain("invalid input: state_location\n");
    expect(events(state, "fetch")).toEqual([]);
    expect(existsSync(join(world.state, "readme", "record.json"))).toBe(false);
    expect(commitCount(world.remote)).toBe(1);
  });
});
