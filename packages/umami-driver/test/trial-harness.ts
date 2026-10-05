// Runs one trial with fakes for everything outside the driver: a synthetic verifier root laid out
// as the kit lays it out, a fake app stack, an injected clock, and a process runner that writes
// canned suite reports and real-format fixture rounds.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodeCanonical, sha256Hex } from "@rbw/schema";
import type { ArtifactManifest, TrialObservations, TrialReason, TrialResult } from "@rbw/schema";
import { suiteEnvironmentManifest } from "../src/environment.ts";
import type { VerifiedIdentity } from "../src/environment.ts";
import { harnessHashes } from "../src/harness.ts";
import type { JobInput } from "../src/job.ts";
import type { LimitsMode } from "../src/limits.ts";
import { buildSuiteManifest, encodeSuiteManifest } from "../src/manifest.ts";
import { parsePlaywrightReport } from "../src/playwright-report.ts";
import type { CommandSpec } from "../src/process.ts";
import type { SampleSources } from "../src/samples.ts";
import { runTrial } from "../src/trial.ts";
import type { AppStack, StepResult, StopReport, TrialOptions } from "../src/trial.ts";
import { CANNED_TESTS, CHECKS, FakeRunner, FakeTimers, commandResult, hex, jobInput, playwrightReport } from "./helpers.ts";
import type { CannedTest, JobOptions } from "./helpers.ts";
import { writeRound } from "./fixture-round/index.ts";
import type { RoundCheck } from "./fixture-round/index.ts";

export const CLOSURE_FILES: Record<string, string> = {
  "playwright.api.config.ts": "export default {};\n",
  "tests/api/alpha.spec.ts": "export const alpha = 1;\n",
  "tests/api/beta.spec.ts": "export const beta = 1;\n",
  "tests/api/report-migration.spec.ts": "import { serializeAnalyticsQuery } from '../../src/lib/analytics-query';\n",
  "src/lib/analytics-query.ts": "export const origin = 'synthetic verifier copy';\n",
};
export const MARKER = '{"name":"synthetic-verifier","private":true,"type":"module"}\n';
export const LOCK = "lockfileVersion: '9.0'\n";
export const BASE_URL = "http://127.0.0.1:3000";
export const NODE_VERSION = "v24.21.0";
export const FIXTURE_DIR = "/synthetic/verifier/kit/umami-fixture";

export function write(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A verifier root as the kit lays it out, and the suite manifest frozen from it. */
export function verifier(root: string) {
  const dir = join(root, "verifier");
  for (const [path, content] of Object.entries(CLOSURE_FILES)) write(join(dir, "suite", path), content);
  const closure = Object.fromEntries(Object.entries(CLOSURE_FILES).map(([path, content]) => [path, sha256Hex(Buffer.from(content))]));
  write(join(dir, "closure.sha256"), Object.entries(closure).map(([path, hash]) => `${hash}  ${path}\n`).join(""));
  write(join(dir, "package.json"), MARKER);
  write(join(dir, "pnpm-lock.yaml"), LOCK);
  mkdirSync(join(dir, "node_modules", "@playwright", "test"), { recursive: true });
  const manifest = buildSuiteManifest({
    report: parsePlaywrightReport(playwrightReport(CANNED_TESTS), "tests/api/"),
    closure,
    harness: harnessHashes(Buffer.from(MARKER)),
    verifierLockSha256: sha256Hex(Buffer.from(LOCK)),
    environment: suiteEnvironmentManifest({ baseUrl: BASE_URL, nodeVersion: NODE_VERSION }),
    specFiles: ["tests/api/alpha.spec.ts", "tests/api/beta.spec.ts"],
    umamiCommit: "ec0ff50388c264ed8ce46f00967e92f7e71476ae",
  });
  return { dir, manifest, encoded: encodeSuiteManifest(manifest) };
}

export interface StackPlan {
  buildMs?: number;
  buildReason?: TrialReason | null;
  startMs?: number;
  startThrows?: boolean;
  identity?: boolean;
  resetMs?: number;
  /** The reset before this round fails with seed_failed. */
  resetFailsAt?: number;
  /** The reset before this round throws an unexpected error. */
  resetThrowsAt?: number;
  stopThrows?: boolean;
}

/** An unexpected error whose message carries a synthetic connection string, which must never reach the records. */
export const SECRET_DETAIL = "postgresql://synthetic-owner:synthetic-secret@db.example.invalid/umami";

export function unexpectedError(): Error {
  return Object.assign(new Error(`synthetic unexpected error at ${SECRET_DETAIL}`), { code: "ECONNRESET" });
}

export class FakeStack implements AppStack {
  readonly kind = "kit" as const;
  readonly baseUrl = BASE_URL;
  readonly events: string[];
  private readonly timers: FakeTimers;
  private readonly plan: StackPlan;
  private readonly logDir: string;

  constructor(timers: FakeTimers, events: string[], plan: StackPlan, logDir: string) {
    this.timers = timers;
    this.events = events;
    this.plan = plan;
    this.logDir = logDir;
  }

  build(): Promise<StepResult> {
    this.events.push("build");
    this.timers.advance(this.plan.buildMs ?? 100000);
    return Promise.resolve({ reason: this.plan.buildReason ?? null, detail: "", logs: [{ name: "build", result: commandResult() }] });
  }

  start(): Promise<StepResult> {
    this.events.push("start");
    if (this.plan.startThrows === true) return Promise.reject(unexpectedError());
    this.timers.advance(this.plan.startMs ?? 10000);
    return Promise.resolve({ reason: null, detail: "", logs: [] });
  }

  verifyIdentity(): Promise<VerifiedIdentity | null> {
    this.events.push("identity");
    return Promise.resolve(this.plan.identity === false ? null : { kind: "kit", base_url: BASE_URL, host: "127.0.0.1", port: 3000, pid: 77 });
  }

  resetFixture(repeatIndex: number): Promise<StepResult> {
    this.events.push(`reset ${String(repeatIndex)}`);
    this.timers.advance(this.plan.resetMs ?? 1000);
    if (this.plan.resetThrowsAt === repeatIndex) return Promise.reject(unexpectedError());
    if (this.plan.resetFailsAt === repeatIndex) return Promise.resolve({ reason: "seed_failed", detail: "", logs: [] });
    return Promise.resolve({ reason: null, detail: "", logs: [] });
  }

  stop(): Promise<StopReport> {
    this.events.push("stop");
    if (this.plan.stopThrows === true) return Promise.reject(new TypeError(`synthetic stop failure at ${SECRET_DETAIL}`));
    this.timers.advance(2000);
    return Promise.resolve({
      ok: true,
      records: [{ pgid: 77, term_sent: false, kill_sent: false, ended: true, waited_ms: 0 }],
      logs: [{ name: "stop", result: commandResult() }],
    });
  }

  logFiles(): { name: string; path: string }[] {
    write(join(this.logDir, "umami.stdout.log"), "synthetic app log\n");
    return [
      { name: "umami.stdout", path: join(this.logDir, "umami.stdout.log") },
      { name: "postgres.stderr", path: join(this.logDir, "postgres.stderr.log") },
    ];
  }
}

export interface Plan {
  job?: JobOptions;
  stack?: StackPlan;
  /** Result per original test; a spec file missing from the suite copy leaves its tests out. */
  original?: (test: CannedTest) => CannedTest["result"];
  suiteMs?: number;
  roundMs?: number;
  round?: (repeatIndex: number) => Partial<Record<string, RoundCheck>>;
  mode?: LimitsMode;
  deleteSpec?: string;
  changeFile?: string;
  artifactLimitBytes?: number;
  events?: string[];
  timers?: FakeTimers;
}

const SAMPLE_SOURCES: SampleSources = {
  readText: (path) =>
    Promise.resolve(path.endsWith("memory.current") ? "1048576\n" : "usage_usec 5000000\nuser_usec 4000000\nsystem_usec 1000000\n"),
  statfs: () => Promise.resolve({ bsize: 4096, blocks: 1000, bfree: 600, bavail: 500 }),
};

/** The job of a trial against this verifier: the frozen suite's hash and tests unless the plan overrides them. */
export function trialJob(root: string, options: JobOptions = {}): JobInput {
  const v = verifier(join(root, "probe"));
  return jobInput({
    originalSuiteSha256: v.encoded.sha256,
    originalTestIds: v.manifest.tests.map((test) => test.id),
    ...options,
  });
}

export async function trial(root: string, plan: Plan = {}) {
  const timers = plan.timers ?? new FakeTimers();
  const events: string[] = plan.events ?? [];
  const v = verifier(root);
  if (plan.deleteSpec !== undefined) rmSync(join(v.dir, "suite", plan.deleteSpec));
  if (plan.changeFile !== undefined) writeFileSync(join(v.dir, "suite", plan.changeFile), "export const changed = 1;\n");
  const job = trialJob(root, plan.job);
  const runner = new FakeRunner((spec: CommandSpec) => {
    if (spec.args.includes("--config=rbw-api.config.ts")) {
      events.push("suite");
      timers.advance(plan.suiteMs ?? 60000);
      if (spec.signal?.aborted === true) return commandResult({ code: null, aborted: true });
      const present = CANNED_TESTS.filter((test) => existsSync(join(spec.cwd, "tests/api", test.file)));
      const tests = present.map((test) => ({ ...test, result: plan.original?.(test) ?? "passed" }));
      write(spec.env.PLAYWRIGHT_JSON_OUTPUT_FILE ?? "", playwrightReport(tests));
      return commandResult({ code: tests.every((test) => test.result === "passed") ? 0 : 1 });
    }
    const repeatIndex = Number(spec.env.RBW_FIXTURE_REPEAT_INDEX);
    events.push(`round ${String(repeatIndex)}`);
    timers.advance(plan.roundMs ?? 5000);
    if (spec.signal?.aborted === true) return commandResult({ code: null, aborted: true });
    const behaviour = plan.round?.(repeatIndex) ?? {};
    const checks = Object.fromEntries(CHECKS.map((check) => [check.check_id, behaviour[check.check_id] ?? "pass"]));
    writeRound(spec.env.RBW_FIXTURE_OUTPUT_DIR ?? "", repeatIndex, checks);
    return commandResult();
  });
  const outDir = join(root, "results", "job");
  const options: TrialOptions = {
    job,
    outDir,
    suite: v.encoded,
    closureDir: join(v.dir, "suite"),
    markerFile: join(v.dir, "package.json"),
    verifierNodeModules: join(v.dir, "node_modules"),
    verifierLockFile: join(v.dir, "pnpm-lock.yaml"),
    appDir: join(root, "app"),
    nodePath: "/synthetic/verifier/node/bin/node",
    nodeVersion: NODE_VERSION,
    limitsMode: plan.mode ?? "enforce",
    development: false,
    fixture: {
      dir: FIXTURE_DIR,
      configPath: join(FIXTURE_DIR, "playwright.config.ts"),
      admin: { username: "synthetic-admin", password: "synthetic-password" },
    },
    addedSuiteSha256: hex(4),
    artifactLimitBytes: plan.artifactLimitBytes,
    samples: { sources: SAMPLE_SOURCES, cgroupDir: "/sys/fs/cgroup", paths: ["/var/lib/rbw/results"] },
  };
  const stack = new FakeStack(timers, events, plan.stack ?? {}, join(root, "logs"));
  const outcome = await runTrial(options, { timers, runner, stack });
  const trialId = job.trial.trial_id;
  const read = (key: string): Buffer => readFileSync(join(outDir, key));
  const json = (key: string): unknown => JSON.parse(read(key).toString("utf8"));
  const result = json(`results/${trialId}/trial-result.json`) as TrialResult;
  return {
    outcome,
    events,
    runner,
    outDir,
    trialId,
    job,
    read,
    json,
    result,
    observations: (json(`results/${trialId}/observations.json`) as TrialObservations).observations,
    observationsRecord: json(`results/${trialId}/observations.json`) as TrialObservations,
    artifacts: json(`results/${trialId}/artifacts.json`) as ArtifactManifest,
    /** An artifact by its key below the trial's artifact directory. */
    artifact: (key: string): unknown => json(`results/${trialId}/artifacts/${key}`),
    canonical: (key: string): boolean => Buffer.from(encodeCanonical(json(key))).equals(read(key)),
  };
}
