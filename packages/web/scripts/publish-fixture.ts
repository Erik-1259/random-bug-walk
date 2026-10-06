// Builds a results fixture by publishing staged runs with the real publisher in local mode, then
// copying what it wrote: the results branch's files to <out>/repository and the store's objects to
// <out>/store. The fixture therefore has exactly the layout and bytes the publisher produces.
//   node scripts/publish-fixture.ts --sources <dir> --out <dir> --gitleaks <command> [--patterns <file>]
// <sources>/roots/<root>.json holds each RootRun without project_id and project_policy_sha256, which
// come from the placeholder policy below; <sources>/staging/<root>/ is that root's staging directory.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildPolicy, encodeCanonical } from "@rbw/schema";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const publisherCli = join(repositoryRoot, "packages/publisher/src/cli.ts");
const scannerCli = join(repositoryRoot, "tools/publication/src/cli.ts");

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
// Assembled at runtime so that no source line holds the synthetic pattern as a literal.
const SYNTHETIC_TERM = ["synthetic", "web", "fixture", "canary"].join("-");

const gitEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(gitDir: string, args: string[]): Buffer {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", `--git-dir=${gitDir}`, ...args], { env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
}

function write(path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

interface Options {
  sources: string;
  out: string;
  gitleaks: string;
  patterns: string | null;
}

function publishFixture(options: Options): void {
  const work = mkdtempSync(join(tmpdir(), "rbw-web-fixture-"));
  try {
    const policy = buildPolicy({
      projectId: PROJECT_ID,
      outputRepository: "https://example.invalid/synthetic-owner/synthetic-results",
      publicArtifactBaseUri: "https://example.invalid/synthetic-store/",
      policyVersion: 1,
    });
    const policyFile = join(work, "policy.json");
    write(policyFile, policy.bytes);
    const patterns = options.patterns ?? join(work, "patterns.txt");
    if (options.patterns === null) write(patterns, `# synthetic pattern list\n${SYNTHETIC_TERM}\n`);
    const remote = join(work, "remote.git");
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote], { env: gitEnv });
    const store = join(work, "store");
    mkdirSync(store);

    const rootFiles = readdirSync(join(options.sources, "roots")).filter((name) => name.endsWith(".json")).sort();
    for (const name of rootFiles) {
      const source = JSON.parse(readFileSync(join(options.sources, "roots", name), "utf8")) as Record<string, unknown>;
      const root: Record<string, unknown> = { schema_version: 1, project_id: PROJECT_ID, project_policy_sha256: policy.sha256, ...source };
      const rootId = String(root.root_execution_id);
      const rootFile = join(work, "roots", name);
      write(rootFile, encodeCanonical(root));
      const staging = join(options.sources, "staging", rootId);
      const terminal = root.status === "terminal";
      // A non-terminal root only gets its status object; the publisher does not read staging for it.
      const stagingArg = terminal ? staging : join(work, "empty-staging");
      mkdirSync(stagingArg, { recursive: true });
      const result = spawnSync(
        process.execPath,
        [
          publisherCli,
          "publish",
          "--policy", policyFile,
          "--root-run", rootFile,
          "--staging", stagingArg,
          "--state", join(work, "state"),
          "--patterns", patterns,
          "--local-remote", remote,
          "--local-store", store,
          "--scanner", `${process.execPath} ${scannerCli}`,
          "--gitleaks", options.gitleaks,
        ],
        { cwd: work, encoding: "utf8" },
      );
      const expected = terminal ? 0 : 3;
      if (result.status !== expected) {
        throw new Error(`publishing ${rootId} exited ${String(result.status)}, expected ${String(expected)}: ${result.stderr.trim()}`);
      }
    }

    rmSync(options.out, { recursive: true, force: true });
    const listing = git(remote, ["ls-tree", "-r", "-z", "refs/heads/main"]).toString("utf8");
    for (const line of listing.split("\0").filter((item) => item.length > 0)) {
      const [meta = "", path = ""] = line.split("\t");
      write(join(options.out, "repository", path), git(remote, ["cat-file", "blob", meta.split(" ")[2] ?? ""]));
    }
    // Files are copied one by one: the store directory's restrictive modes are not part of the fixture.
    for (const path of readdirSync(store, { recursive: true, encoding: "utf8" }).sort()) {
      const from = join(store, path);
      if (statSync(from).isFile()) write(join(options.out, "store", path), readFileSync(from));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const { values } = parseArgs({
  options: {
    sources: { type: "string" },
    out: { type: "string" },
    gitleaks: { type: "string" },
    patterns: { type: "string" },
  },
});
if (values.sources === undefined || values.out === undefined || values.gitleaks === undefined) {
  process.stderr.write("usage: node scripts/publish-fixture.ts --sources <dir> --out <dir> --gitleaks <command> [--patterns <file>]\n");
  process.exit(2);
}
if (!existsSync(join(values.sources, "roots"))) {
  process.stderr.write("the sources directory has no roots/ directory\n");
  process.exit(2);
}
publishFixture({ sources: resolve(values.sources), out: resolve(values.out), gitleaks: values.gitleaks, patterns: values.patterns === undefined ? null : resolve(values.patterns) });
