// A simulated kit image behind the fake Docker layer. Each trial copy runs the real driver's
// runTrial, with the driver's own test fakes for the app stack and its processes; the simulated
// app answers the added checks according to the target file placed in the copy. The record sets
// are therefore the ones the real driver code writes, and the real importer reads them.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { sha256Hex } from "@rbw/schema";
import type { ExpectedCheck } from "@rbw/schema";
import { addedSuiteSha256, loadJob, runTrial } from "@rbw/umami-driver";
import type { TrialOptions } from "@rbw/umami-driver";
import { writeObservation } from "@rbw/umami-fixture";
import { CANNED_TESTS, FakeRunner, FakeTimers, commandResult, playwrightReport } from "../../../../packages/umami-driver/test/helpers.ts";
import type { CannedTest } from "../../../../packages/umami-driver/test/helpers.ts";
import { cannedResponse } from "../../../../packages/umami-driver/test/fixture-round/index.ts";
import { FIXTURE_DIR, FakeStack, NODE_VERSION, verifier, write } from "../../../../packages/umami-driver/test/trial-harness.ts";
import type { StackPlan } from "../../../../packages/umami-driver/test/trial-harness.ts";
import type { CommandResult, RunOptions } from "../../src/docker.ts";
import { FakeDocker, failed, ok } from "./fakes.ts";
import { ALTERNATIVE, CLEAN, PARTIAL, PLANTED, STUB, appTree, sha256, tarOf, tempDir, writeKitStage } from "./synthetic.ts";

export const IMAGE_ID = `sha256:${"9".repeat(64)}`;

type Behaviour = "clean" | "planted" | "partial" | "stub";

/** What the simulated app does with each target file: the fix gives clean behaviour, as does the alternative fix. */
const BEHAVIOUR_BY_FILE = new Map<string, Behaviour>([
  [sha256(CLEAN), "clean"],
  [sha256(PLANTED), "planted"],
  [sha256(PARTIAL), "partial"],
  [sha256(STUB), "stub"],
  [sha256(ALTERNATIVE), "clean"],
]);

const PASS = { observed: "pass", code: null } as const;
const COUNTS = { observed: "assertion_fail", code: "local_day_counts_mismatch" } as const;
const LABELS = { observed: "assertion_fail", code: "bucket_labels_mismatch" } as const;
type Outcome = typeof PASS | typeof COUNTS | typeof LABELS;

const APP: Record<Behaviour, Record<string, Outcome>> = {
  clean: { "tzarg.utc-day-counts": PASS, "tzarg.la-day-counts": PASS, "tzarg.auckland-day-counts": PASS, "tzarg.kolkata-day-counts": PASS },
  planted: { "tzarg.utc-day-counts": PASS, "tzarg.la-day-counts": COUNTS, "tzarg.auckland-day-counts": COUNTS, "tzarg.kolkata-day-counts": COUNTS },
  partial: { "tzarg.utc-day-counts": PASS, "tzarg.la-day-counts": COUNTS, "tzarg.auckland-day-counts": PASS, "tzarg.kolkata-day-counts": COUNTS },
  stub: { "tzarg.utc-day-counts": PASS, "tzarg.la-day-counts": LABELS, "tzarg.auckland-day-counts": LABELS, "tzarg.kolkata-day-counts": LABELS },
};

const SAMPLE_SOURCES = {
  readText: (path: string) => Promise.resolve(path.endsWith("memory.current") ? "1048576\n" : "usage_usec 5000000\nuser_usec 4000000\nsystem_usec 1000000\n"),
  statfs: () => Promise.resolve({ bsize: 4096, blocks: 1000, bfree: 600, bavail: 500 }),
};

export interface KitImageOptions {
  /** Per trial: a stack plan for the driver's fake app stack, for example an internal error. */
  stack?: Record<string, StackPlan>;
  /** Trials whose container never exits by itself. */
  hang?: readonly string[];
  /** Called when a hung container is being waited on, so the test can let the outer limit pass. */
  onHang?: () => void;
}

interface Container {
  mode: "trial" | "freeze";
  trialId: string;
  runnerDir: string;
  jobDir: string | null;
  placed: Buffer | null;
  exit: number | null;
  running: boolean;
  wake: (() => void) | null;
}

export class KitImage {
  readonly root = tempDir("rbw-local-runner-kit-");
  readonly suite = verifier(join(this.root, "verifier-root"));
  readonly kitStage = writeKitStage(this.root);
  readonly containers = new Map<string, Container>();
  readonly created: string[] = [];
  readonly docker: FakeDocker;
  readonly placedFiles = new Map<string, string>();
  private readonly options: KitImageOptions;

  constructor(options: KitImageOptions = {}) {
    this.options = options;
    this.docker = new FakeDocker((args, runOptions) => this.handle(args, runOptions));
  }

  private async handle(args: readonly string[], options: RunOptions): Promise<CommandResult> {
    const [command] = args;
    if (command === "image") return ok(`${IMAGE_ID}\n`);
    if (command === "create") return this.create(args);
    if (command === "cp") return this.copy(args, options);
    if (command === "start") return this.start(String(args[1]));
    if (command === "wait") return this.wait(String(args[1]));
    if (command === "kill") return this.kill(String(args[3]));
    if (command === "rm") return ok();
    return failed(125, `unexpected docker command ${args.join(" ")}`);
  }

  private create(args: readonly string[]): CommandResult {
    const name = String(args[2]);
    this.created.push(name);
    const modeIndex = args.indexOf("rbw-copy");
    const mode = modeIndex === -1 ? null : args[modeIndex + 1];
    if (mode === "trial" || mode === "freeze") {
      this.containers.set(name, { mode, trialId: String(args[modeIndex + 2]), runnerDir: join(this.root, "containers", name), jobDir: null, placed: null, exit: null, running: false, wake: null });
    }
    return ok();
  }

  private async copy(args: readonly string[], options: RunOptions): Promise<CommandResult> {
    const [, from, to] = args.map(String);
    if (from === undefined || to === undefined) return failed(1);
    if (to === "-") {
      const stream = options.stdout as Writable;
      const bytes = from.endsWith(":/workspace/app") ? await appTree() : await tarOf([{ name: "image-manifest.json", content: '{"synthetic":"image manifest"}', mode: 0o600 }]);
      stream.end(bytes);
      return ok();
    }
    if (to.includes(":")) {
      const [name, path] = to.split(":");
      const container = this.containers.get(name ?? "");
      if (container === undefined) return failed(1, "no such container");
      if (path === "/var/lib/rbw/job") container.jobDir = from;
      else {
        container.placed = readFileSync(from);
        this.placedFiles.set(name ?? "", sha256Hex(container.placed));
      }
      return ok();
    }
    const [name] = from.split(":");
    const container = this.containers.get(name ?? "");
    if (container === undefined) return failed(1, "no such container");
    if (!existsSync(container.runnerDir)) return failed(1, "no such path in the container");
    cpSync(container.runnerDir, to, { recursive: true });
    return ok();
  }

  private start(name: string): CommandResult {
    const container = this.containers.get(name);
    if (container === undefined) return failed(1, "no such container");
    container.running = true;
    return ok();
  }

  private async wait(name: string): Promise<CommandResult> {
    const container = this.containers.get(name);
    if (container === undefined) return failed(1, "no such container");
    if (this.options.hang?.includes(container.trialId) === true && container.mode === "trial") {
      await new Promise<void>((resolve) => {
        container.wake = resolve;
        setImmediate(() => this.options.onHang?.());
      });
      return ok(`${String(container.exit ?? 137)}\n`);
    }
    container.exit = await this.runInside(container);
    container.running = false;
    return ok(`${String(container.exit)}\n`);
  }

  private kill(name: string): CommandResult {
    const container = this.containers.get(name);
    if (container?.running === true) {
      container.running = false;
      container.exit = 137;
      container.wake?.();
    }
    return ok();
  }

  /** The copy script: freeze, then the driver's run, each exit status written as the script writes it. */
  private async runInside(container: Container): Promise<number> {
    const dir = container.runnerDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "freeze.exit"), "0\n");
    if (container.mode === "freeze") {
      writeFileSync(join(dir, "original-suite.json"), this.suite.encoded.bytes);
      return 0;
    }
    if (container.jobDir === null) return 2;
    const code = await this.runDriver(container, container.jobDir, join(dir, "out"));
    writeFileSync(join(dir, "run.exit"), `${String(code)}\n`);
    return code;
  }

  private async runDriver(container: Container, jobDir: string, outDir: string): Promise<number> {
    const job = loadJob(jobDir, container.trialId);
    const placedSha = container.placed === null ? sha256(CLEAN) : sha256Hex(container.placed);
    const app = APP[BEHAVIOUR_BY_FILE.get(placedSha) ?? "clean"];
    const timers = new FakeTimers();
    const runner = new FakeRunner((spec) => {
      if (spec.args.includes("--config=rbw-api.config.ts")) {
        timers.advance(60000);
        const tests: CannedTest[] = CANNED_TESTS.map((test) => ({ ...test, result: "passed" }));
        write(spec.env.PLAYWRIGHT_JSON_OUTPUT_FILE ?? "", playwrightReport(tests));
        return commandResult();
      }
      timers.advance(1000);
      writeRound(spec.env.RBW_FIXTURE_OUTPUT_DIR ?? "", Number(spec.env.RBW_FIXTURE_REPEAT_INDEX), job.trial.expected_checks, app);
      return commandResult();
    });
    const stack = new FakeStack(timers, [], this.options.stack?.[container.trialId] ?? {}, join(this.root, "logs", container.trialId, String(Math.random()).slice(2)));
    const options: TrialOptions = {
      job,
      outDir,
      suite: this.suite.encoded,
      closureDir: join(this.suite.dir, "suite"),
      markerFile: join(this.suite.dir, "package.json"),
      verifierNodeModules: join(this.suite.dir, "node_modules"),
      verifierLockFile: join(this.suite.dir, "pnpm-lock.yaml"),
      appDir: join(this.root, "app"),
      nodePath: "/synthetic/verifier/node/bin/node",
      nodeVersion: NODE_VERSION,
      limitsMode: "enforce",
      development: false,
      fixture: { dir: FIXTURE_DIR, configPath: join(FIXTURE_DIR, "playwright.config.ts"), admin: { username: "synthetic-admin", password: "synthetic-password" } },
      addedSuiteSha256: await addedSuiteSha256(join(this.kitStage, "umami-fixture")),
      samples: { sources: SAMPLE_SOURCES, cgroupDir: "/sys/fs/cgroup", paths: [outDir] },
    };
    const outcome = await runTrial(options, { timers, runner, stack });
    return outcome.internal_error === null ? 0 : 3;
  }
}

/** One fixture round: the simulated app's outcome for each expected check, written by the fixture's own writer. */
function writeRound(outputDir: string, repeatIndex: number, checks: readonly ExpectedCheck[], app: Record<string, Outcome>): void {
  const tests: CannedTest[] = [];
  for (const check of checks) {
    const outcome = app[check.check_id] ?? PASS;
    tests.push({ id: `synthetic-${check.check_id}`, file: "tzarg.check.ts", title: check.check_id, result: outcome.observed === "pass" ? "passed" : "failed", duration: 25 });
    writeObservation(outputDir, {
      check_id: check.check_id,
      repeat_index: repeatIndex,
      observed: outcome.observed,
      failure_code: outcome.code,
      duration_ms: 25,
      response_body: cannedResponse(check.check_id),
    });
  }
  writeFileSync(join(outputDir, "report.json"), playwrightReport(tests));
}
