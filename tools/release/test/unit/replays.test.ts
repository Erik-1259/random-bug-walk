import { cpSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { RootRun } from "@rbw/schema";
import { jobContext } from "../../src/judge-job.ts";
import { publishReplays } from "../../src/replays.ts";
import { commitCount, destination, git } from "../support/publish.ts";
import { PROJECT_ID, canonical, rootIds, runJobCopies, tempDir, world, write } from "../support/world.ts";
import type { World } from "../support/world.ts";

let w: World;
let runs: string;
const roots: { id: string; status: RootRun["status"] }[] = [];

/** One judge replay laid out as the private store holds it: judge/<root>/root-run.json, progress.json and run/jobs/judge/. */
async function replay(group: string, status: RootRun["status"]): Promise<void> {
  const ids = rootIds(group);
  const work = tempDir();
  const { ctx } = await jobContext(w.docker, w.sources, {
    ids,
    deadlineAt: "2026-12-02T12:00:00Z",
    projectPolicy: { sha256: w.policy.sha256, policy_id: "umami-uc3-v1" },
    judgeFixed: "fixed",
    issue: { sha256: "f".repeat(64), style: "user-report" },
    exportDir: join(work, "source"),
  });
  const base = join(runs, "judge", ids.root_execution_id);
  if (status === "terminal") {
    const judge = await runJobCopies(w, join(work, "run"), "judge", "alternative-fix", ctx);
    for (const name of ["summary.json", "evidence.json", "decision.json", "job", "records"]) cpSync(join(judge.jobDir, name), join(base, "run", "jobs", "judge", name), { recursive: true });
  }
  const root: RootRun = {
    schema_version: 1,
    project_id: PROJECT_ID,
    root_execution_id: ids.root_execution_id,
    project_policy_sha256: w.policy.sha256,
    kind: "judge_replay",
    declared_stages: ["judge_verify"],
    child_execution_ids: [ids.executions["alternative-fix"]],
    status,
    outcome: status === "terminal" ? "completed" : null,
  };
  write(join(base, "root-run.json"), canonical(root));
  write(join(base, "progress.json"), canonical({ created_at: "2026-12-02T11:30:00Z", synthetic: true }));
  roots.push({ id: ids.root_execution_id, status });
}

beforeAll(async () => {
  w = world();
  runs = join(tempDir(), "private-runs");
  await replay("8302", "terminal");
  await replay("8301", "running");
  await replay("8303", "terminal");
});

describe("publish-replays", () => {
  it("skips roots that are not terminal and publishes the rest one at a time in root order; a second run is idempotent", async () => {
    const d = destination(w);
    const lines: string[] = [];
    const run = () =>
      publishReplays(
        { policy: w.policy.file, state: d.state, patterns: w.patterns, localRuns: runs, publishArgs: d.flags },
        { env: {}, out: (line) => lines.push(line), privateStoreFromEnv: () => {
          throw new Error("synthetic: local mode must not ask for the real store");
        } },
      );
    const first = await run();
    expect(first).toBe(0);
    const terminal = roots.filter((root) => root.status === "terminal").map((root) => root.id).sort();
    const running = roots.find((root) => root.status === "running")?.id ?? "";
    expect(lines).toEqual([`root ${running} skipped not_terminal`, ...terminal.map((id) => `root ${id} published`)].sort((a, b) => (a.split(" ")[1] ?? "").localeCompare(b.split(" ")[1] ?? "")));
    const log = git(d.remote, ["log", "--format=%s", "--reverse", "refs/heads/main"]).toString("utf8").trim().split("\n");
    expect(log).toEqual(terminal.map((id) => `chore(runs): publish ${id}`));
    for (const id of terminal) expect(git(d.remote, ["ls-tree", "--name-only", `refs/heads/main:runs/${id}`]).toString("utf8")).toContain("manifest.json");

    lines.length = 0;
    expect(await run()).toBe(0);
    expect(lines.filter((line) => line.endsWith("published"))).toHaveLength(terminal.length);
    expect(commitCount(d.remote)).toBe(terminal.length);
  });
});
