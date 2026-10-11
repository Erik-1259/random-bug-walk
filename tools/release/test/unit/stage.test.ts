import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseCanonical, parseRecord } from "@rbw/schema";
import type { RootRun, RunManifest, StagingOmissions } from "@rbw/schema";
import { stage } from "../../src/stage.ts";
import { checkout, destination, git, publish } from "../support/publish.ts";
import { canonical, factoryRun, generatedFiles, rootIds, runJobCopies, tempDir, world, write } from "../support/world.ts";
import type { FactoryRun, World } from "../support/world.ts";
import { jobContext } from "../../src/judge-job.ts";

function files(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else found.push(relative(dir, path));
    }
  };
  walk(dir);
  return found;
}

function allBytes(dir: string): Buffer {
  return Buffer.concat(files(dir).map((path) => readFileSync(join(dir, path))));
}

function omissions(staging: string): StagingOmissions {
  return parseRecord("StagingOmissions", readFileSync(join(staging, "omissions.json")));
}

function rootFile(dir: string, root: RootRun): string {
  return write(join(dir, `root-run-${String(Math.random()).slice(2)}.json`), canonical(root));
}

let w: World;
let factory: FactoryRun;

beforeAll(async () => {
  w = world();
  factory = await factoryRun(w);
});

describe("stage", () => {
  it("stages a completed factory root in the web's paths, flattened below results/<execution>/, and the real publisher accepts it", async () => {
    const dir = tempDir();
    const generated = generatedFiles(dir);
    const out = join(dir, "staging");
    const redactions = join(dir, "private", "redactions.txt");
    const outcome = stage({ run: factory.run, rootRun: factory.rootRunFile, out, redactionsOut: redactions, ...generated });
    expect(outcome.ok).toBe(true);
    const exec = factory.ids.executions.admission;
    const staged = files(out);
    for (const path of ["generated/symptom.json", "generated/card.json", "generated/novelty.json", "report.md", "omissions.json"]) expect(staged).toContain(path);
    for (const name of ["evidence.json", "decision.json", "summary.json", "request.json", "expected-trials.json"]) expect(staged).toContain(`results/${exec}/${name}`);
    for (const trial of factory.admission.built.expected.trials) expect(staged).toContain(`results/${exec}/${trial.trial_id}/trial-result.json`);
    // Nothing below results/<execution>/ names an execution, so the publisher's UUID-segment rule holds.
    expect(staged.filter((path) => path.split("/").slice(2).some((segment) => /^[0-9a-f]{8}-/.test(segment)))).toEqual([]);
    expect(readFileSync(join(out, "results", exec, "request.json"))).toEqual(readFileSync(join(factory.admission.jobDir, "records", "request.json")));
    expect(readFileSync(join(out, "results", exec, "evidence.json"))).toEqual(readFileSync(join(factory.admission.jobDir, "evidence.json")));

    const declared = omissions(out);
    expect(declared.entries.filter((entry) => entry.outcome === "withheld_private")).toHaveLength(5);
    expect(declared.entries.every((entry) => entry.outcome === "withheld_private" && entry.reason === "private_material")).toBe(true);

    const d = destination(w);
    const { result, record } = await publish(w, d, { rootRun: factory.rootRunFile, staging: out, redactions });
    expect(result.code).toBe(0);
    expect(record?.status).toBe("published");
    const manifest = parseRecord("RunManifest", git(d.remote, ["cat-file", "blob", `refs/heads/main:runs/${factory.ids.root_execution_id}/manifest.json`]));
    expect(manifest.entries.find((entry) => entry.path === `results/${exec}/summary.json`)?.redactions).toEqual([{ category: "provider_identifier", count: 26 }]);
  });

  it("puts provider resource IDs only in the private redaction file, and the publisher replaces them", async () => {
    const dir = tempDir();
    const out = join(dir, "staging");
    const redactions = join(dir, "private", "redactions.txt");
    stage({ run: factory.run, rootRun: factory.rootRunFile, out, redactionsOut: redactions, ...generatedFiles(dir) });
    const resources = factory.admission.summary.copies.map((copy) => copy.child_resource_id ?? "");
    const lines = readFileSync(redactions, "utf8").split("\n").filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(lines).toEqual([...new Set([...resources, ...factory.admission.summary.copies.map((copy) => copy.copy?.container ?? "")])].sort().map((id) => `provider_identifier\t${id}`));
    expect(relative(out, redactions).startsWith("..")).toBe(true);

    const d = destination(w);
    expect((await publish(w, d, { rootRun: factory.rootRunFile, staging: out, redactions })).result.code).toBe(0);
    const published = checkout(d.remote, `runs/${factory.ids.root_execution_id}`);
    const bytes = allBytes(published);
    for (const id of resources) expect(bytes.includes(Buffer.from(id))).toBe(false);
    expect(bytes.includes(Buffer.from("[redacted:provider_identifier]"))).toBe(true);
  });

  it("withholds the issue, its check report, the phrase records and the writer and search recordings from the run record", async () => {
    const dir = tempDir();
    const issueText = ["synthetic", "issue", "title", "text"].join("-");
    const phrase = ["synthetic", "phrase", "words"].join("-");
    const prompt = ["synthetic", "writer", "prompt"].join("-");
    // A factory run directory may hold the private material beside the jobs; stage never takes it.
    write(join(factory.run, "candidate", "issue.json"), JSON.stringify({ title: issueText }));
    write(join(factory.run, "candidate", "issue-check.json"), JSON.stringify({ status: "ready_for_review", note: issueText }));
    write(join(factory.run, "candidate", "phrases", "phrase-1.json"), JSON.stringify({ phrase }));
    write(join(factory.run, "candidate", "recordings", "issue-1.recording.json"), JSON.stringify({ prompt }));
    write(join(factory.run, "candidate", "search", "phrase-1.recording.json"), JSON.stringify({ phrase }));
    const out = join(dir, "staging");
    const redactions = join(dir, "private", "redactions.txt");
    try {
      stage({ run: factory.run, rootRun: factory.rootRunFile, out, redactionsOut: redactions, ...generatedFiles(dir) });
      const d = destination(w);
      expect((await publish(w, d, { rootRun: factory.rootRunFile, staging: out, redactions })).result.code).toBe(0);
      const repository = git(d.remote, ["cat-file", "--batch-all-objects", "--batch"]);
      for (const value of [issueText, phrase, prompt]) {
        expect(allBytes(out).includes(Buffer.from(value))).toBe(false);
        expect(repository.includes(Buffer.from(value))).toBe(false);
      }
      const manifest = parseRecord("RunManifest", git(d.remote, ["cat-file", "blob", `refs/heads/main:runs/${factory.ids.root_execution_id}/manifest.json`]));
      expect(manifest.entries.filter((entry) => entry.outcome === "withheld_private").map((entry) => entry.reason)).toEqual(Array<string>(5).fill("private_material"));
    } finally {
      rmSync(join(factory.run, "candidate"), { recursive: true, force: true });
    }
  });

  it("stages a judge_replay root from its downloaded run directory, with no generated files and nothing withheld", async () => {
    const ids = rootIds("8100");
    const base = tempDir();
    const run = join(base, "run");
    const { ctx } = await jobContext(w.docker, w.sources, {
      ids,
      deadlineAt: "2026-12-02T12:00:00Z",
      projectPolicy: { sha256: w.policy.sha256, policy_id: "umami-uc3-v1" },
      judgeFixed: "fixed",
      issue: { sha256: "f".repeat(64), style: "user-report" },
      exportDir: join(base, "source"),
    });
    const judge = await runJobCopies(w, run, "judge", "alternative-fix", ctx);
    const root: RootRun = { ...factory.rootRun, root_execution_id: ids.root_execution_id, kind: "judge_replay", declared_stages: ["judge_verify"], child_execution_ids: [judge.built.request.execution_id] };
    const rootRun = rootFile(base, root);
    const out = join(base, "staging");
    const outcome = stage({ run, rootRun, out, redactionsOut: join(base, "private", "redactions.txt") });
    expect(outcome.ok).toBe(true);
    const exec = judge.built.request.execution_id;
    expect(files(out).filter((path) => path.startsWith("generated/"))).toEqual([]);
    expect(files(out)).toContain(`results/${exec}/fixed-01/trial-result.json`);
    expect(omissions(out).entries).toEqual([]);
    const d = destination(w);
    expect((await publish(w, d, { rootRun, staging: out, redactions: join(base, "private", "redactions.txt") })).result.code).toBe(0);
  });

  it("declares what a failed root did not produce as not_produced, and the publisher accepts it", async () => {
    const dir = tempDir();
    const missing = "00000000-0000-4000-8000-0000000000f1";
    const root: RootRun = { ...factory.rootRun, outcome: "failed", child_execution_ids: [...factory.rootRun.child_execution_ids, missing] };
    const rootRun = rootFile(dir, root);
    const out = join(dir, "staging");
    const redactions = join(dir, "private", "redactions.txt");
    expect(stage({ run: factory.run, rootRun, out, redactionsOut: redactions }).ok).toBe(true);
    const notProduced = omissions(out).entries.flatMap((entry) => (entry.outcome === "not_produced" ? [`${entry.path} ${entry.reason}`] : []));
    expect(notProduced).toEqual([
      "generated/card.json stage_failed",
      "generated/novelty.json stage_failed",
      "generated/symptom.json stage_failed",
      `results/${missing}/decision.json stage_failed`,
      `results/${missing}/evidence.json stage_failed`,
      `results/${missing}/summary.json stage_failed`,
    ]);
    const d = destination(w);
    const { result } = await publish(w, d, { rootRun, staging: out, redactions });
    expect(result.code).toBe(0);
    const manifest = parseCanonical(git(d.remote, ["cat-file", "blob", `refs/heads/main:runs/${factory.ids.root_execution_id}/manifest.json`])) as unknown as RunManifest;
    expect(manifest.entries.filter((entry) => entry.outcome === "not_produced").map((entry) => entry.path)).toContain(`results/${missing}/evidence.json`);
  });

  it("declares an incomplete root's missing evidence and decision as not_produced", () => {
    const dir = tempDir();
    const run = join(dir, "run");
    for (const name of ["summary.json", "records"]) {
      const from = join(factory.admission.jobDir, name);
      if (statSync(from).isDirectory()) for (const path of files(from)) write(join(run, "jobs", "admission", name, path), readFileSync(join(from, path)));
      else write(join(run, "jobs", "admission", name), readFileSync(from));
    }
    const rootRun = rootFile(dir, { ...factory.rootRun, outcome: "incomplete" });
    const out = join(dir, "staging");
    expect(stage({ run, rootRun, out, redactionsOut: join(dir, "private", "redactions.txt"), ...generatedFiles(dir) }).ok).toBe(true);
    const exec = factory.ids.executions.admission;
    expect(omissions(out).entries.flatMap((entry) => (entry.outcome === "not_produced" ? [entry.path] : []))).toEqual([`results/${exec}/decision.json`, `results/${exec}/evidence.json`]);
    expect(files(out)).toContain(`results/${exec}/summary.json`);
  });

  it("refuses a root that is not terminal and writes nothing", () => {
    const dir = tempDir();
    const rootRun = rootFile(dir, { ...factory.rootRun, status: "running", outcome: null });
    const out = join(dir, "staging");
    const redactions = join(dir, "private", "redactions.txt");
    expect(stage({ run: factory.run, rootRun, out, redactionsOut: redactions, ...generatedFiles(dir) })).toEqual({ ok: false, code: "root_not_terminal" });
    expect(existsSync(out)).toBe(false);
    expect(existsSync(redactions)).toBe(false);
  });
});
