import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InputsError, newRunIds } from "@rbw/local-runner";
import type { RunIds } from "@rbw/local-runner";
import { assertRecord, parseCanonical, parseRecord, sha256Hex } from "@rbw/schema";
import { loadFixture } from "@rbw/umami-fixture";
import { pickPhrases, prepareAttempt, runAttempt } from "../../src/attempt.ts";
import type { AttemptOutcome } from "../../src/attempt.ts";
import { runJob } from "../../src/controller.ts";
import { PLACEHOLDER_PROJECT_ID } from "../../../local-runner/src/jobs.ts";
import { SymptomUnavailable, buildSymptom } from "../../src/symptom.ts";
import { ATTEMPT_PROJECT_ID, MATCH_URL, SEARCH_KEY, WRITER_KEY, attemptDeps, attemptFiles, attemptInputs, privateInput, syntheticIssue } from "../support/attempt.ts";
import type { AttemptFiles, AttemptWorld, IssueMode, PhraseAnswer } from "../support/attempt.ts";
import { jobInputs, uuids, world } from "../support/harness.ts";
import { FakeClock } from "../../../local-runner/test/support/fakes.ts";
import type { LedgerCall, World } from "../support/harness.ts";

// The driver's canned response bodies are not shaped like Umami's; the observation needs counts.
vi.mock("../../../../packages/umami-driver/test/fixture-round/index.ts", async (importOriginal) => {
  const { umamiResponse } = await import("../support/umami-response.ts");
  return { ...(await importOriginal<Record<string, unknown>>()), cannedResponse: umamiResponse };
});

const CLI = new URL("../../src/cli.ts", import.meta.url).pathname;
const POLICY_SHA = "ab".repeat(32);
const UC3 = "umami-uc3-v1";

interface Run {
  w: World;
  files: AttemptFiles;
  aw: AttemptWorld;
  work: string;
  outcome: AttemptOutcome;
}

/** One attempt on a world whose clock moves only when released: each simulated copy would otherwise take its whole outer limit, and 13 of them overrun the admission's deadline. */
async function attempt(options: { issue?: IssueMode; phrases?: readonly PhraseAnswer[] } = {}): Promise<Run> {
  const w = await world({ clock: new FakeClock({ manual: true }) });
  const files = attemptFiles(w.dir);
  const inputs = attemptInputs(w, files);
  const aw = attemptDeps(w, inputs.work, options);
  const outcome = await runAttempt(prepareAttempt(inputs, aw.env), aw.deps);
  return { w, files, aw, work: inputs.work, outcome };
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((path) => join(dir, path)).filter((path) => statSync(path).isFile());
}

function reserves(calls: readonly LedgerCall[]): { call_name: string; kind: string; project_id: string; project_policy_sha256: string; root_execution_id: string; task_revision: string }[] {
  return calls.filter((call) => call.method === "reserve").map((call) => call.request as never);
}

function issueOf(run: Run): string[] {
  const issue = parseCanonical(readFileSync(join(run.work, "candidate", "issue.json"))) as unknown as { title: string; expected_result: string; actual_result: string };
  return [issue.title, issue.expected_result, issue.actual_result, ...pickPhrases(issue as never)];
}

async function slotHolder(w: World): Promise<string | null> {
  const status = await w.spend.slotStatus({ slot_key: "development" });
  if (!status.ok) throw new Error("synthetic: no slot status");
  return status.holder;
}

describe("runJob with shared IDs and a project policy", () => {
  it("names the given root, project, policy hash and policy_id in every request, and both go into the fingerprint", async () => {
    const w = await world();
    const ids: RunIds = { ...newRunIds(uuids("9100")), project_id: ATTEMPT_PROJECT_ID };
    const projectPolicy = { sha256: POLICY_SHA, policy_id: UC3 };
    const inputs = jobInputs(w, { kind: "kit_check", name: "kit-check", trials: ["clean-01"], backend: "docker", sandboxImage: null, ids, projectPolicy });
    const outcome = await runJob(inputs, w.deps);
    expect(outcome.status).toBe("complete");
    const request = parseRecord("JobRequest", readFileSync(join(outcome.jobDir, "job", "request.json")));
    expect(request).toMatchObject({ project_id: ATTEMPT_PROJECT_ID, project_policy_sha256: POLICY_SHA, policy_id: UC3, root_execution_id: ids.root_execution_id, batch_id: ids.batch_id, execution_id: ids.executions["kit-check"] });
    expect(reserves(w.ledgerCalls).length).toBeGreaterThan(0);
    for (const reserve of reserves(w.ledgerCalls)) expect(reserve).toMatchObject({ project_id: ATTEMPT_PROJECT_ID, project_policy_sha256: POLICY_SHA, root_execution_id: ids.root_execution_id });
    expect((JSON.parse(readFileSync(join(outcome.jobDir, "controller.json"), "utf8")) as { ids: RunIds }).ids).toEqual(ids);

    await expect(runJob({ ...inputs, projectPolicy: { sha256: "cd".repeat(32), policy_id: UC3 } }, w.deps)).rejects.toThrow(/another job/);
    await expect(runJob({ ...inputs, ids: { ...ids, project_id: "00000000-0000-4000-8000-0000000000a2" } }, w.deps)).rejects.toThrow(/another job/);
    expect((await runJob(inputs, w.deps)).replay).toBe(true);
  });

  it("without them, writes today's bytes: the placeholder project and policy, and the same fingerprint and request", async () => {
    const w = await world();
    const outcome = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check", trials: ["clean-01"] }), w.deps);
    const requestBytes = readFileSync(join(outcome.jobDir, "job", "request.json"));
    const request = parseRecord("JobRequest", requestBytes);
    expect(request).toMatchObject({ project_id: PLACEHOLDER_PROJECT_ID, project_policy_sha256: "0".repeat(64), policy_id: "local-development" });
    // Recorded from the controller before the two optional fields existed.
    expect((JSON.parse(readFileSync(join(outcome.jobDir, "controller.json"), "utf8")) as { fingerprint: string }).fingerprint).toBe("4caabf456ce848317160d5613e6fdb5c07199b1f02871c96f4b9473e87aed953");
    expect(sha256Hex(requestBytes)).toBe("3c9034c9a80031c31566334f9e5c006edd6c1f546a41dbcedbe5415bf84d5c74");
  });
});

describe("the observed symptom", () => {
  let observeDir: string;
  const prose = { user_action: "Opened the synthetic daily report.", locale: "en-US", fixture_description: "Twelve synthetic pageviews.", doc_excerpts: [] };

  beforeAll(async () => {
    const w = await world();
    const common = { backend: "docker" as const, sandboxImage: null, work: join(w.dir, "run") };
    const kit = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check", ...common }), w.deps);
    const observe = await runJob(jobInputs(w, { kind: "observe", name: "observe", ...common, originalSuite: join(kit.jobDir, "freeze", "collected", "original-suite.json") }), w.deps);
    expect(observe.status).toBe("complete");
    observeDir = observe.jobDir;
  });

  function responseCounts(checkId: string): number[] {
    const path = files(join(observeDir, "records", "results")).find((file) => file.endsWith(`/responses/${checkId}.json`)) ?? "";
    return (JSON.parse(readFileSync(path, "utf8")) as { pageviews: { y: number }[] }).pageviews.map((item) => item.y);
  }

  it("is a valid ObservedSymptom: the fixture's request, events and expected counts, and the observed counts of the recorded responses", () => {
    const fixture = loadFixture();
    const symptom = buildSymptom(observeDir, prose);
    expect(assertRecord("ObservedSymptom", symptom)).toBe(symptom);
    const [, la, auckland, kolkata] = fixture.checks;
    const labels = fixture.bucket_labels.map((label) => label.slice(0, 10));
    expect(labels).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
    expect(symptom.timezone).toBe(la?.timezone);
    expect(symptom.request).toEqual({ method: "GET", path: fixture.request.path, query: { startAt: String(fixture.request.startAt), endAt: String(fixture.request.endAt), unit: "day", timezone: la?.timezone } });
    expect(symptom.expected).toEqual(labels.map((bucket_label, index) => ({ bucket_label, count: la?.expected[index] })));
    expect(symptom.observed.map((bucket) => bucket.count)).toEqual(responseCounts("tzarg.la-day-counts"));
    expect(symptom.observed.map((bucket) => bucket.bucket_label)).toEqual(labels);
    expect(symptom.follow_up_examples.map((example) => example.timezone)).toEqual([auckland?.timezone, kolkata?.timezone]);
    expect(symptom.follow_up_examples[0]?.observed.map((bucket) => bucket.count)).toEqual(responseCounts("tzarg.auckland-day-counts"));
    expect(symptom.follow_up_examples[1]?.expected.map((bucket) => bucket.count)).toEqual(kolkata?.expected);
    expect(JSON.stringify(symptom)).not.toContain("UTC\"");
    expect(symptom.events).toHaveLength(12);
    expect(symptom.events[0]).toEqual({ label: "pageview e01", timestamp_seconds: fixture.events[0]?.timestamp_seconds, utc_instant: fixture.events[0]?.utc_instant });
    expect(symptom).toMatchObject({ http_status: 200, ...prose });
  });

  it("refuses with symptom_unavailable when a non-UTC check has no recorded response", () => {
    const path = files(join(observeDir, "records", "results")).find((file) => file.endsWith("/responses/tzarg.kolkata-day-counts.json")) ?? "";
    const bytes = readFileSync(path);
    rmSync(path);
    try {
      expect(() => buildSymptom(observeDir, prose)).toThrow(SymptomUnavailable);
    } finally {
      writeFileSync(path, bytes);
    }
  });
});

describe("the phrase picker", () => {
  it("picks three phrases from the frozen issue: the title and the first sentences of the expected and actual results, each cut to 12 words with no double quote", () => {
    const issue = {
      title: 'A  "quoted"\ntitle that runs well past the twelve word limit of an exact phrase check',
      reproduction_steps: ["Step."],
      expected_result: "Each visit is counted   on its local day. A second sentence.",
      actual_result: 'Some visits move to the "neighboring" day! More text.',
      environment: "Synthetic.",
    };
    const phrases = pickPhrases(issue);
    expect(phrases).toEqual(["A quoted title that runs well past the twelve word limit of", "Each visit is counted on its local day.", "Some visits move to the neighboring day!"]);
    expect(pickPhrases(issue)).toEqual(phrases);
    for (const phrase of phrases) {
      expect(phrase.split(" ").length).toBeLessThanOrEqual(12);
      expect(phrase).not.toContain('"');
    }
  });
});

describe("the phrase picker, short opening sentences", () => {
  it("takes the start of the field, up to 12 words, when its first sentence has fewer than 6 words", () => {
    const issue = {
      title: "Daily visitor counts shift by one day for a named time zone",
      reproduction_steps: ["Step."],
      expected_result: "Counts are right. Each of the three days shows the visits stored for that local day.",
      actual_result: "Counts are wrong. Two of the three days show visits that belong to the next day.",
      environment: "Synthetic.",
    };
    const [, expected, actual] = pickPhrases(issue);
    expect(expected).toBe("Counts are right. Each of the three days shows the visits stored");
    expect(actual).toBe("Counts are wrong. Two of the three days show visits that belong");
    for (const phrase of [expected, actual]) expect(phrase.split(" ").length).toBeGreaterThanOrEqual(6);
  });
});

describe("one attempt: a root under the policy, start to finish", () => {
  let run: Run;

  beforeAll(async () => {
    run = await attempt();
  });

  it("runs the kit check, the observation, the card, the issue, phrase-1 to phrase-3 and the admission, in that order, under one root", () => {
    expect(run.outcome.exitCode).toBe(0);
    const names = reserves(run.w.ledgerCalls).map((reserve) => reserve.call_name.replace(/^(sandbox\.copy:[a-z-]+):.*$/, "$1"));
    const collapsed = names.filter((name, index) => name !== names[index - 1]);
    expect(collapsed).toEqual([
      "sandbox.copy:kit-check",
      "sandbox.copy:observe",
      "writer.card:synthetic-candidate-1:1",
      "writer.issue:synthetic-candidate-1:2",
      "search.phrase:synthetic-candidate-1:phrase-1",
      "search.phrase:synthetic-candidate-1:phrase-2",
      "search.phrase:synthetic-candidate-1:phrase-3",
      "sandbox.copy:admission",
    ]);
    expect(names.filter((name) => name === "sandbox.copy:admission")).toHaveLength(13);
    const root = run.outcome.rootRun.root_execution_id;
    for (const reserve of reserves(run.w.ledgerCalls)) expect(reserve).toMatchObject({ project_id: ATTEMPT_PROJECT_ID, project_policy_sha256: run.files.policy.sha256, root_execution_id: root });
    const admission = parseRecord("JobRequest", readFileSync(join(run.work, "jobs", "admission", "job", "request.json")));
    const text = reserves(run.w.ledgerCalls).filter((reserve) => !reserve.call_name.startsWith("sandbox.copy"));
    expect(new Set(text.map((reserve) => reserve.task_revision))).toEqual(new Set([admission.task_revision]));
    expect(admission).toMatchObject({ project_id: ATTEMPT_PROJECT_ID, project_policy_sha256: run.files.policy.sha256, policy_id: UC3, root_execution_id: root });
  });

  it("writes a canonical terminal, completed RootRun naming the three job executions", () => {
    const bytes = readFileSync(join(run.work, "root-run.json"));
    const rootRun = parseRecord("RootRun", bytes);
    const executions = ["kit-check", "observe", "admission"].map((name) => (JSON.parse(readFileSync(join(run.work, "jobs", name, "controller.json"), "utf8")) as { ids: RunIds }).ids.executions[name as "observe"]);
    expect(rootRun).toEqual({
      schema_version: 1,
      project_id: ATTEMPT_PROJECT_ID,
      root_execution_id: run.outcome.rootRun.root_execution_id,
      project_policy_sha256: run.files.policy.sha256,
      kind: "factory",
      declared_stages: ["kit_check", "observe", "write", "novelty", "admission"],
      child_execution_ids: executions,
      status: "terminal",
      outcome: "completed",
    });
    expect(new Set(executions).size).toBe(3);
  });

  it("freezes the candidate's outputs once, binds the check report and the novelty summary to the issue, and lists each operation's spend", () => {
    const dir = join(run.work, "candidate");
    const issueSha256 = sha256Hex(readFileSync(join(dir, "issue.json")));
    expect(parseCanonical(readFileSync(join(dir, "issue-check.json")))).toMatchObject({ status: "ready_for_review", issue_sha256: issueSha256 });
    expect(parseCanonical(readFileSync(join(dir, "novelty.json")))).toEqual({ status: "clear", matching_urls: [], incomplete_calls: [], issue_sha256: issueSha256 });
    const symptom = parseRecord("ObservedSymptom", readFileSync(join(dir, "symptom.json")));
    expect(parseCanonical(readFileSync(join(dir, "issue.json")))).toEqual(syntheticIssue(symptom));
    expect(readdirSync(join(dir, "recordings")).sort()).toEqual(["card-1.recording.json", "issue-2.recording.json"]);
    expect(readdirSync(join(dir, "search")).sort()).toEqual(["phrase-1", "phrase-2", "phrase-3"].map((name) => `synthetic-candidate-1.${name}.record.json`));
    const ledger = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")) as { operations: { operation_id: string; kind: string; state: string; reserved_microusd: number; settled_microusd: number }[] };
    expect(ledger.operations.map((operation) => [operation.kind, operation.state])).toEqual([
      ["writer.card", "reconciled"],
      ["writer.issue", "reconciled"],
      ["search.phrase", "reconciled"],
      ["search.phrase", "reconciled"],
      ["search.phrase", "reconciled"],
    ]);
    expect(ledger.operations.every((operation) => operation.settled_microusd > 0 && operation.settled_microusd <= operation.reserved_microusd)).toBe(true);
    expect(new Set(ledger.operations.map((operation) => operation.operation_id))).toEqual(new Set(reserves(run.w.ledgerCalls).filter((reserve) => !reserve.call_name.startsWith("sandbox.copy")).map((reserve) => (reserve as unknown as { operation_id: string }).operation_id)));
  });

  it("acquires the development slot for the root before the card, releases it after the last phrase check, and leaves it free", async () => {
    const methods = run.w.ledgerCalls.map((call) => `${call.method}:${(call.request as { call_name?: string }).call_name ?? ""}`);
    const card = methods.indexOf("reserve:writer.card:synthetic-candidate-1:1");
    const lastPhrase = methods.indexOf("reserve:search.phrase:synthetic-candidate-1:phrase-3");
    const firstAdmission = methods.findIndex((method) => method.startsWith("reserve:sandbox.copy:admission"));
    const acquires = methods.flatMap((method, index) => (method.startsWith("acquireSlot") ? [index] : []));
    const releases = methods.flatMap((method, index) => (method.startsWith("releaseSlot") ? [index] : []));
    expect(acquires.some((index) => index < card && index > methods.lastIndexOf("releaseSlot:", card))).toBe(true);
    expect(releases.some((index) => index > lastPhrase && index < firstAdmission)).toBe(true);
    expect(await slotHolder(run.w)).toBeNull();
  });

  it("prints outcomes only: no issue text, phrase or URL reaches a report line, a log line, a job directory or the RootRun", () => {
    const secrets = issueOf(run);
    expect(run.aw.search.queries.map((query) => query.replace(/^"|"$/g, ""))).toEqual(secrets.slice(3));
    const lines = [...run.aw.lines, ...run.w.logs].join("\n");
    expect(run.aw.lines.some((line) => line.startsWith("stage=admission") && line.includes("outcome_verdict=pass"))).toBe(true);
    expect(run.aw.lines.some((line) => line.includes("issue_check=ready_for_review"))).toBe(true);
    expect(run.aw.lines.some((line) => line.startsWith("stage=novelty") && line.includes("status=clear"))).toBe(true);
    const published = [lines, readFileSync(join(run.work, "root-run.json"), "utf8"), ...files(join(run.work, "jobs")).map((file) => readFileSync(file, "latin1"))];
    for (const secret of secrets) for (const text of published) expect(text).not.toContain(secret);
    expect(lines).not.toMatch(/https?:/);
  });

  it("reads both keys once, removes them from the environment before any Docker call, and writes neither anywhere", () => {
    expect(run.aw.env.TOKEN_FACTORY_WRITER_KEY).toBeUndefined();
    expect(run.aw.env.TAVILY_API_KEY).toBeUndefined();
    expect(run.aw.dockerEnvs.length).toBeGreaterThan(0);
    for (const env of run.aw.dockerEnvs) expect(Object.values(env)).not.toContain(WRITER_KEY);
    for (const env of run.aw.dockerEnvs) expect(Object.values(env)).not.toContain(SEARCH_KEY);
    expect(run.aw.writer.calls.map((call) => call.authorization)).toEqual([`Bearer ${WRITER_KEY}`, `Bearer ${WRITER_KEY}`]);
    expect(run.aw.search.keys).toEqual([SEARCH_KEY]);
    const written = [...run.aw.lines, ...run.w.logs, ...files(run.work).map((file) => readFileSync(file, "latin1"))];
    for (const text of written) {
      expect(text).not.toContain(WRITER_KEY);
      expect(text).not.toContain(SEARCH_KEY);
    }
  });
});

describe("the attempt's stops", () => {
  it("stops a root whose issue is not ready_for_review: no search, no admission, failed, and the slot is released", async () => {
    const run = await attempt({ issue: "rejected" });
    expect(run.outcome.exitCode).toBe(1);
    expect(run.outcome.rootRun).toMatchObject({ status: "terminal", outcome: "failed" });
    expect(run.aw.search.queries).toEqual([]);
    expect(existsSync(join(run.work, "jobs", "admission"))).toBe(false);
    expect(parseCanonical(readFileSync(join(run.work, "candidate", "issue-check.json")))).toMatchObject({ status: "rejected" });
    expect(run.outcome.rootRun.child_execution_ids).toHaveLength(2);
    expect(await slotHolder(run.w)).toBeNull();
  });

  it("stops a root whose novelty is blocked before the admission: failed", async () => {
    const run = await attempt({ phrases: ["none", "match", "none"] });
    expect(run.outcome).toMatchObject({ exitCode: 1, rootRun: { status: "terminal", outcome: "failed" } });
    expect(parseCanonical(readFileSync(join(run.work, "candidate", "novelty.json")))).toMatchObject({ status: "blocked", matching_urls: [MATCH_URL] });
    expect(existsSync(join(run.work, "jobs", "admission"))).toBe(false);
    expect(run.aw.lines.join("\n")).not.toContain(MATCH_URL);
    expect(await slotHolder(run.w)).toBeNull();
  });

  it("stops a root whose novelty is incomplete before the admission: incomplete", async () => {
    const run = await attempt({ phrases: ["error", "none", "none"] });
    expect(run.outcome).toMatchObject({ exitCode: 1, rootRun: { status: "terminal", outcome: "incomplete" } });
    expect(parseCanonical(readFileSync(join(run.work, "candidate", "novelty.json")))).toMatchObject({ status: "incomplete", incomplete_calls: ["phrase-1"] });
    expect(existsSync(join(run.work, "jobs", "admission"))).toBe(false);
  });

  it("stops at an uncertain writer call: needs_reconciliation with no outcome, the slot held, and nothing more run", async () => {
    const run = await attempt({ issue: "lost" });
    expect(run.outcome.exitCode).toBe(1);
    expect(run.outcome.rootRun).toMatchObject({ status: "needs_reconciliation", outcome: null });
    expect(parseRecord("RootRun", readFileSync(join(run.work, "root-run.json"))).status).toBe("needs_reconciliation");
    expect(run.aw.search.queries).toEqual([]);
    expect(existsSync(join(run.work, "jobs", "admission"))).toBe(false);
    expect(await slotHolder(run.w)).toBe(run.outcome.rootRun.root_execution_id);
    const ledger = JSON.parse(readFileSync(join(run.work, "candidate", "ledger.json"), "utf8")) as { operations: { kind: string; state: string }[] };
    expect(ledger.operations.map((operation) => [operation.kind, operation.state])).toEqual([
      ["writer.card", "reconciled"],
      ["writer.issue", "uncertain"],
    ]);
  });
});

describe("the attempt's inputs", () => {
  it("never resumes: a work directory that is not empty is refused, with nothing run", async () => {
    const w = await world();
    const files = attemptFiles(w.dir);
    const inputs = attemptInputs(w, files);
    mkdirSync(inputs.work, { recursive: true });
    writeFileSync(join(inputs.work, "root-run.json"), "{}");
    const aw = attemptDeps(w, inputs.work);
    expect(() => prepareAttempt(inputs, aw.env)).toThrow(InputsError);
    expect(w.ledgerCalls).toEqual([]);
    expect(aw.dockerEnvs).toEqual([]);
  });

  it("refuses a private input that does not match its format before anything runs", async () => {
    const w = await world();
    const files = attemptFiles(w.dir, { ...privateInput(), candidate: "x".repeat(41) });
    const aw = attemptDeps(w, join(w.dir, "attempt"));
    expect(() => prepareAttempt(attemptInputs(w, files), aw.env)).toThrow(InputsError);
    expect(w.ledgerCalls).toEqual([]);
  });
});

describe("the attempt command", () => {
  const args = (work: string) => ["attempt", "--work", work, "--policy", "p.json", "--candidate", "c.json", "--writer-rates", "w.json", "--search-rates", "s.json", "--image", "rbw-umami-kit:synthetic", "--manifest", "m.json", "--terms", "t.txt", "--audit-policy", "a.json", "--kit-stage", "k", "--sandbox-image", "vcr.example.invalid/synthetic/kit@sha256:" + "cd".repeat(32)];
  const env = { PATH: process.env.PATH ?? "", DATABASE_URL: "postgres://synthetic.invalid/db", VERCEL_TOKEN: "synthetic-token", VERCEL_TEAM_ID: "synthetic-team", VERCEL_PROJECT_ID: "synthetic-project", TOKEN_FACTORY_WRITER_KEY: WRITER_KEY };

  it("exits 2 and names a missing variable, with nothing run", () => {
    const dir = mkdtempSync(join(tmpdir(), "rbw-attempt-cli-"));
    try {
      const work = join(dir, "run");
      const result = spawnSync(process.execPath, [CLI, ...args(work)], { env, encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("TAVILY_API_KEY is not set");
      expect(`${result.stdout}${result.stderr}`).not.toContain(WRITER_KEY);
      expect(existsSync(work)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 2 for a work directory that is not empty, before any connection", () => {
    const work = mkdtempSync(join(tmpdir(), "rbw-attempt-cli-"));
    writeFileSync(join(work, "root-run.json"), "{}");
    try {
      const result = spawnSync(process.execPath, [CLI, ...args(work)], { env: { ...env, TAVILY_API_KEY: SEARCH_KEY }, encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("not empty");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
