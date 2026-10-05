import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { buildExpectedTrials, buildJobRequest } from "@rbw/schema";
import type { ExpectedCheck, JobKind } from "@rbw/schema";
import { readJob } from "../src/job.ts";
import type { JobInput } from "../src/job.ts";
import type { Timers } from "../src/limits.ts";
import type { CommandResult, CommandSpec, LongProcess, ProcessRunner } from "../src/process.ts";

export const START = Date.parse("2026-10-05T00:00:00.000Z");

/** A clock and timer queue that only move when a test, or a fake process, moves them. */
export class FakeTimers implements Timers {
  current: number;
  private queue: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;

  constructor(start = START) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const entry = { at: this.current + Math.max(0, ms), seq: this.seq++, fn };
    this.queue.push(entry);
    return () => {
      this.queue = this.queue.filter((item) => item !== entry);
    };
  }

  /** Timers still waiting to run. */
  pending(): number {
    return this.queue.length;
  }

  sleep(ms: number): Promise<void> {
    this.advance(ms);
    return Promise.resolve();
  }

  /** Moves the clock forward, running every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.queue.filter((item) => item.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (due === undefined) break;
      this.queue = this.queue.filter((item) => item !== due);
      this.current = Math.max(this.current, due.at);
      due.fn();
    }
    this.current = target;
  }
}

/** 64 lowercase hexadecimal characters derived from a small number. */
export function hex(n: number): string {
  return n.toString(16).padStart(64, "0");
}

/** A lowercase UUID string derived from a small number. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** A temporary directory removed after the current test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-driver-"));
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

export function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    code: 0,
    signal: null,
    spawn_failed: false,
    aborted: false,
    stdout: { bytes: Buffer.from(""), total_bytes: 0, truncated: false },
    stderr: { bytes: Buffer.from(""), total_bytes: 0, truncated: false },
    stop: null,
    ...overrides,
  };
}

export type FakeBehaviour = (spec: CommandSpec) => CommandResult | Promise<CommandResult>;

/** Records every command and answers with the behaviour the test supplies. */
export class FakeRunner implements ProcessRunner {
  readonly calls: CommandSpec[] = [];
  private readonly behaviour: FakeBehaviour;

  constructor(behaviour: FakeBehaviour = () => commandResult()) {
    this.behaviour = behaviour;
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec);
    return this.behaviour(spec);
  }

  start(spec: CommandSpec): LongProcess {
    this.calls.push(spec);
    return { pid: 4242 + this.calls.length, result: new Promise<CommandResult>(() => undefined) };
  }
}

export interface CannedTest {
  id: string;
  file: string;
  describe?: string[];
  title: string;
  /** Omitted for a `--list` report, where Playwright reports every test as skipped without results. */
  result?: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration?: number;
}

/** A Playwright JSON report in the shape the JSON reporter writes. */
export function playwrightReport(tests: CannedTest[], errors: string[] = []): string {
  const files = [...new Set(tests.map((test) => test.file))];
  const suites = files.map((file) => {
    const fileSuite = { title: file, file, line: 0, column: 0, specs: [] as unknown[], suites: [] as unknown[] };
    for (const test of tests.filter((item) => item.file === file)) {
      let container: { specs: unknown[]; suites: unknown[] } = fileSuite;
      for (const title of test.describe ?? []) {
        const existing = (container.suites as { title: string; specs: unknown[]; suites: unknown[] }[]).find(
          (suite) => suite.title === title,
        );
        if (existing !== undefined) {
          container = existing;
        } else {
          const created = { title, file, line: 1, column: 1, specs: [] as unknown[], suites: [] as unknown[] };
          container.suites.push(created);
          container = created;
        }
      }
      const status =
        test.result === undefined || test.result === "skipped"
          ? "skipped"
          : test.result === "passed"
            ? "expected"
            : "unexpected";
      container.specs.push({
        title: test.title,
        ok: test.result !== "failed",
        tags: [],
        id: test.id,
        file,
        line: 2,
        column: 3,
        tests: [
          {
            timeout: 30000,
            annotations: [],
            expectedStatus: "passed",
            projectId: "api",
            projectName: "api",
            results:
              test.result === undefined
                ? []
                : [{ workerIndex: 0, status: test.result, duration: test.duration ?? 12, errors: [], retry: 0 }],
            status,
          },
        ],
      });
    }
    return fileSuite;
  });
  return JSON.stringify({
    config: { rootDir: "/synthetic/suite/tests/api", workers: 1 },
    suites,
    errors: errors.map((message) => ({ message })),
    stats: { startTime: "2026-10-05T00:00:00.000Z", duration: 1 },
  });
}

/** A small synthetic suite: two spec files, one with a parameterized test expanded three times. */
export const CANNED_TESTS: CannedTest[] = [
  { id: "synthetic0001-aaaa0001", file: "alpha.spec.ts", describe: ["Alpha"], title: "GET /api/alpha returns rows" },
  { id: "synthetic0001-aaaa0002", file: "alpha.spec.ts", describe: ["Alpha"], title: "POST /api/alpha creates a row" },
  ...["funnel", "retention", "journey"].map((type, index) => ({
    id: `synthetic0002-bbbb000${String(index + 1)}`,
    file: "beta.spec.ts",
    describe: ["Beta", "migration"],
    title: `${type} report migrates`,
  })),
];

/** The four added checks, in the fixture's query order (the UTC control first), all expected to pass. */
export const CHECKS: readonly ExpectedCheck[] = [
  { check_id: "tzarg.utc-day-counts", expected: "pass", failure_code: null },
  { check_id: "tzarg.la-day-counts", expected: "pass", failure_code: null },
  { check_id: "tzarg.auckland-day-counts", expected: "pass", failure_code: null },
  { check_id: "tzarg.kolkata-day-counts", expected: "pass", failure_code: null },
];

export const EXECUTION_ID = uuid(2);
export const EXPECTED_TRIALS_KEY = `jobs/${EXECUTION_ID}/expected-trials.json`;

export interface JobOptions {
  kind?: JobKind;
  /** kit_check's clean-01 has 20 repetitions and clean-02 one; observe's planted-01 runs no original suite. */
  trialId?: string;
  originalSuiteSha256?: string | null;
  originalTestIds?: readonly string[];
  addedSuiteSha256?: string;
}

/** The two job files, built with the shared schema's own builders. */
export function jobFiles(options: JobOptions = {}): { requestBytes: Uint8Array; expectedTrialsBytes: Uint8Array } {
  const kind = options.kind ?? "kit_check";
  const expected = buildExpectedTrials({
    kind,
    executionId: EXECUTION_ID,
    taskRevision: hex(9),
    patchSha256: { planted: hex(11), fixed: hex(12), partial: hex(13), stub: hex(14) },
    originalSuiteSha256: options.originalSuiteSha256 === undefined ? hex(3) : options.originalSuiteSha256,
    originalTestIds: options.originalTestIds ?? CANNED_TESTS.map((test) => test.id).sort(),
    addedSuiteSha256: options.addedSuiteSha256 ?? hex(4),
    checks: { clean: CHECKS, planted: CHECKS, fixed: CHECKS, partial: CHECKS, stub: CHECKS },
  });
  const request = buildJobRequest({
    schema_version: 1,
    project_id: uuid(10),
    project_policy_sha256: hex(1),
    batch_id: uuid(11),
    execution_id: EXECUTION_ID,
    root_execution_id: uuid(1),
    parent_execution_id: uuid(1),
    attempt_ordinal: 1,
    kind,
    task_revision: hex(9),
    policy_id: "synthetic-policy-1",
    runtime_profile_sha256: hex(5),
    image_digest: `sha256:${hex(6)}`,
    expected_trials_key: EXPECTED_TRIALS_KEY,
    expected_trials_sha256: expected.sha256,
    baseline_evidence_key: kind === "observe" ? "jobs/synthetic-baseline.json" : null,
    baseline_evidence_sha256: kind === "observe" ? hex(7) : null,
    deadline_at: "2026-10-05T18:00:00Z",
    reservation_microusd: 1,
    release_id: kind === "judge_verify" ? uuid(12) : null,
  });
  return { requestBytes: request.bytes, expectedTrialsBytes: expected.bytes };
}

/** A job input read through the driver's own reader. */
export function jobInput(options: JobOptions = {}): JobInput {
  const files = jobFiles(options);
  const kind = options.kind ?? "kit_check";
  const trialId = options.trialId ?? (kind === "observe" ? "planted-01" : "clean-02");
  return readJob(files.requestBytes, (key) => (key === EXPECTED_TRIALS_KEY ? files.expectedTrialsBytes : null), trialId);
}
