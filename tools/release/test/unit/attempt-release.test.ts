import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RATE_SHEET_PATH, prepareAttempt, runAttempt } from "@rbw/controller";
import type { AttemptDeps, AttemptInputs } from "@rbw/controller";
import { loadRateSheet } from "@rbw/envelope";
import { candidateIdentity } from "@rbw/local-runner";
import { parseCanonical, parseRecord, sha256Hex, taskRevision } from "@rbw/schema";
import { buildRelease } from "../../src/build.ts";
import { provisionalOf } from "../../src/check.ts";
import { jobContext } from "../../src/judge-job.ts";
import { stage } from "../../src/stage.ts";
import { attemptFiles, fakeSearch, fakeWriter, SEARCH_KEY, WRITER_KEY } from "../../../controller/test/support/attempt.ts";
import { pgliteLedger, uuids } from "../../../controller/test/support/harness.ts";
import { FakeClock } from "../../../local-runner/test/support/fakes.ts";

type WorldModule = typeof import("../support/world.ts");
type PublishModule = typeof import("../support/publish.ts");

// The driver's canned response bodies are not shaped like Umami's; the observation needs counts.
// The setup file has already loaded the simulated kit, so the modules that reach it are loaded
// again below, after a registry reset, to take the mock.
vi.mock("../../../../packages/umami-driver/test/fixture-round/index.ts", async (importOriginal) => {
  const { umamiResponse } = await import("../../../controller/test/support/umami-response.ts");
  return { ...(await importOriginal<Record<string, unknown>>()), cannedResponse: umamiResponse };
});

function allFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((path) => join(dir, path)).filter((path) => statSync(path).isFile());
}

let support: WorldModule;
let publishing: PublishModule;

beforeAll(async () => {
  vi.resetModules();
  support = await import("../support/world.ts");
  publishing = await import("../support/publish.ts");
});

afterAll(() => {
  support.cleanupTempDirs();
});

describe("a candidate attempt, staged, published and built into a release", () => {
  it("gives a release that passes every check, under the attempt's policy, whose complete revision reduces to the admission's", async () => {
    const { CONTROLLER_IMAGE, PROJECT_ID, RELEASE_ID, canonical, rootIds, tempDir, world, write } = support;
    const { checkout, destination, publish } = publishing;
    const w = world();
    const dir = tempDir();
    const files = attemptFiles(dir);
    expect(files.policy.projectId).not.toBe(PROJECT_ID);
    const work = join(dir, "attempt");
    const inputs: AttemptInputs = {
      work,
      policy: files.policy.file,
      candidate: files.candidate,
      writerRates: files.writerRates,
      searchRates: files.searchRates,
      image: w.sources.image,
      manifest: w.sources.manifest,
      terms: w.sources.terms,
      auditPolicy: w.sources.auditPolicy,
      kitStage: w.sources.kitStage,
      originalSuite: w.sources.originalSuite,
      probesDir: w.sources.probesDir,
      alternativeDir: w.sources.alternativeDir,
      backend: "docker",
      sandboxImage: null,
    };
    // A clock that moves only when released: each simulated copy would otherwise take its whole outer limit, and 13 overrun the admission's deadline.
    const clock = new FakeClock({ manual: true });
    const ledger = await pgliteLedger(clock);
    const lines: string[] = [];
    const deps: AttemptDeps = {
      docker: w.docker,
      clock,
      uuid: uuids("8200"),
      spend: ledger.spend,
      ledgerKind: "in_memory",
      rates: await loadRateSheet(RATE_SHEET_PATH),
      log: (line) => {
        lines.push(line);
      },
      writerFetch: fakeWriter(work).fetch,
      searchClient: fakeSearch().client,
      report: (line) => {
        lines.push(line);
      },
    };
    const attempted = await runAttempt(prepareAttempt(inputs, { TOKEN_FACTORY_WRITER_KEY: WRITER_KEY, TAVILY_API_KEY: SEARCH_KEY }), deps);
    await ledger.close();
    expect(attempted.exitCode).toBe(0);

    const candidate = join(work, "candidate");
    const rootRun = join(work, "root-run.json");
    const staging = join(dir, "staging");
    const redactions = join(dir, "private", "redactions.txt");
    const staged = stage({ run: work, rootRun, out: staging, redactionsOut: redactions, symptom: join(candidate, "symptom.json"), card: join(candidate, "card.json"), novelty: join(candidate, "novelty.json") });
    expect(staged.ok).toBe(true);
    const issue = parseCanonical(readFileSync(join(candidate, "issue.json"))) as unknown as { title: string; expected_result: string; actual_result: string };
    // The six search records: two source searches, the docs extract and three phrase checks. Every query is private.
    const queries = readdirSync(join(candidate, "search")).map((file) => (JSON.parse(readFileSync(join(candidate, "search", file), "utf8")) as { request: { query: string } }).request.query.replace(/^"|"$/g, ""));
    expect(queries).toHaveLength(6);
    const stagedText = allFiles(staging).map((file) => readFileSync(file, "latin1"));
    for (const secret of [issue.title, issue.expected_result, issue.actual_result, ...queries]) for (const text of [...stagedText, lines.join("\n")]) expect(text).not.toContain(secret);

    const pw = { ...w, policy: { file: files.policy.file, bytes: files.policy.bytes, sha256: files.policy.sha256 } };
    const d = destination(pw);
    const published = await publish(pw, d, { rootRun, staging, redactions });
    expect(published.result.code).toBe(0);
    if (published.record === null) throw new Error("synthetic: no publication record");
    const root = attempted.rootRun.root_execution_id;

    const { ctx } = await jobContext(w.docker, w.sources, { ids: rootIds("8300"), deadlineAt: "2026-10-06T12:00:00Z", exportDir: join(tempDir(), "source") });
    const issueSha256 = sha256Hex(readFileSync(join(candidate, "issue.json")));
    const out = join(dir, "release");
    const built = await buildRelease(
      {
        releaseId: RELEASE_ID,
        run: checkout(d.remote, `runs/${root}`),
        publication: write(join(dir, "publication.json"), canonical(published.record)),
        policy: files.policy.file,
        rootRun,
        issue: join(candidate, "issue.json"),
        issueCheck: join(candidate, "issue-check.json"),
        recordings: join(candidate, "recordings"),
        approval: write(join(dir, "approval.json"), canonical({ decision: "approved", issue_sha256: issueSha256, reviewed_at: "2026-10-14T10:00:00Z" })),
        registry: write(
          join(dir, "families.json"),
          canonical({ schema_version: 1, families: [{ family_id: "synthetic-family-1", exposure: "public", held_out_eligible: false, source_fixes: [{ upstream: "synthetic-upstream", commit: "a".repeat(40) }], mutation_ids: [candidateIdentity(ctx).mutation_id] }] }),
        ),
        heldOut: write(join(dir, "held-out.json"), canonical({ schema_version: 1, family_ids: [], source_fixes: [], mutation_ids: [] })),
        sources: w.sources,
        controllerImage: CONTROLLER_IMAGE,
        localStore: join(dir, "private-store"),
        out,
      },
      {
        docker: w.docker,
        clock: w.clock,
        rates: deps.rates,
        env: {},
        privateStoreFromEnv: () => {
          throw new Error("synthetic: local mode must not ask for the real store");
        },
        log: () => undefined,
      },
    );
    expect(built).toMatchObject({ ok: true });
    if (!built.ok) throw new Error(`synthetic: build refused ${built.codes.join(",")}`);
    expect(built.release.project_id).toBe(files.policy.projectId);
    expect(built.release.project_policy_sha256).toBe(files.policy.sha256);
    const admission = parseRecord("JobRequest", readFileSync(join(work, "jobs", "admission", "job", "request.json")));
    expect(built.release.admission.execution_id).toBe(admission.execution_id);
    const [revision] = built.release.revisions;
    if (revision === undefined) throw new Error("synthetic: no revision");
    expect(revision.identity.issue_sha256).toBe(issueSha256);
    expect(taskRevision(provisionalOf(revision.identity)).sha256).toBe(admission.task_revision);
  });
});
