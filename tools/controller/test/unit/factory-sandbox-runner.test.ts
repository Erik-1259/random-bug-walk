import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pack } from "tar-stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CopyPlan, CopyRoots } from "@rbw/factory-contract";
import type { SandboxInstance, SandboxSdk } from "@rbw/local-runner";
import { sha256Hex } from "@rbw/schema";
import { copyOperation } from "../../src/factory-ledger.ts";
import { CopyMeter } from "../../src/factory-meter.ts";
import type { FactoryRequestRecord } from "../../src/factory-ports.ts";
import { NO_IMAGE_DIGEST, SandboxCopyUncertain, createSandboxCopyRunner, pinnedImage, sandboxVcpus } from "../../src/factory-sandbox-runner.ts";
import type { SandboxRunnerDeps } from "../../src/factory-sandbox-runner.ts";
import { CANDIDATE_A, SYNTHETIC_REQUEST_NAMESPACE, acceptRequest, factoryWorld, operationState } from "./factory-fakes.ts";
import type { FactoryWorld } from "./factory-fakes.ts";

const DIGEST = `sha256:${"e9".repeat(32)}`;
const APP = "export const synthetic = 1;\n";
const CHECK = "synthetic check\n";

type SandboxCreate = Parameters<SandboxSdk["create"]>[0];
type CommandParams = Parameters<SandboxInstance["runCommand"]>[0];

/** A fake Sandbox: an in-memory file system per sandbox; the copy's command is the test's. */
class FakeSandbox implements SandboxSdk {
  readonly creates: SandboxCreate[] = [];
  readonly files = new Map<string, Map<string, Buffer>>();
  readonly commands: CommandParams[] = [];
  readonly stops: string[] = [];
  readonly instances = new Map<string, SandboxInstance & { status: string }>();
  createError: Error | null = null;
  reportedImage: string | null = null;
  stopTakesEffect = true;
  /** The copy's command: writes results into the sandbox's file system and returns its exit code. */
  copy: (fs: Map<string, Buffer>) => number = (fs) => {
    fs.set("/workspace/results/record.json", Buffer.from('{"synthetic":true}\n'));
    return 0;
  };
  /** Extra archive entries the results tar holds. */
  extraEntries: { name: string; type: "file" | "symlink" }[] = [];

  create(params: SandboxCreate): Promise<SandboxInstance> {
    this.creates.push(params);
    if (this.createError !== null) return Promise.reject(this.createError);
    const fs = new Map<string, Buffer>();
    this.files.set(params.name, fs);
    const instance = {
      name: params.name,
      status: "running",
      image: this.reportedImage ?? params.image,
      tags: params.tags,
      writeFiles: (files: { path: string; content: Uint8Array }[]) => {
        for (const file of files) fs.set(file.path, Buffer.from(file.content));
        return Promise.resolve();
      },
      runCommand: (command: CommandParams) => {
        this.commands.push(command);
        if (command.signal?.aborted === true) return Promise.reject(new Error("synthetic: aborted"));
        let exitCode = 0;
        if (command.cmd === "tar") {
          this.archive.set(params.name, this.tarOf(fs, command.args[1] ?? ""));
        } else if (command.cmd !== "mkdir") {
          exitCode = this.copy(fs);
        }
        return Promise.resolve({ wait: (options?: { signal?: AbortSignal }) => (options?.signal?.aborted === true ? Promise.reject(new Error("synthetic: aborted")) : Promise.resolve({ exitCode })) });
      },
      readFile: async () => {
        const bytes = await this.archive.get(params.name);
        return bytes === undefined ? null : Readable.from([bytes]);
      },
      stop: () => {
        this.stops.push(params.name);
        if (this.stopTakesEffect) instance.status = "stopped";
        return Promise.resolve(undefined);
      },
    };
    this.instances.set(params.name, instance as unknown as SandboxInstance & { status: string });
    return Promise.resolve(instance as unknown as SandboxInstance);
  }

  get(name: string): Promise<SandboxInstance | null> {
    return Promise.resolve(this.instances.get(name) ?? null);
  }

  readonly archive = new Map<string, Promise<Buffer>>();

  tarOf(fs: Map<string, Buffer>, dir: string): Promise<Buffer> {
    const archive = pack();
    for (const [path, content] of fs) if (path.startsWith(`${dir}/`)) archive.entry({ name: `./${path.slice(dir.length + 1)}` }, content);
    for (const entry of this.extraEntries) {
      if (entry.type === "symlink") archive.entry({ name: entry.name, type: "symlink", linkname: "/etc/passwd" });
      else archive.entry({ name: entry.name }, "x");
    }
    archive.finalize();
    return new Promise((done, fail) => {
      const chunks: Buffer[] = [];
      archive.on("data", (chunk: unknown) => {
        if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      });
      archive.on("end", () => {
        done(Buffer.concat(chunks));
      });
      archive.on("error", fail);
    });
  }
}

let w: FactoryWorld;
let record: FactoryRequestRecord;
let sdk: FakeSandbox;
let roots: CopyRoots;
let work: string;

beforeEach(async () => {
  w = await factoryWorld();
  record = await acceptRequest(w);
  sdk = new FakeSandbox();
  const base = mkdtempSync(join(tmpdir(), "rbw-factory-runner-test-"));
  roots = { app_root: join(base, "app"), evaluator_root: join(base, "evaluator") };
  mkdirSync(join(roots.app_root, "src"), { recursive: true });
  mkdirSync(join(roots.evaluator_root, "checks"), { recursive: true });
  writeFileSync(join(roots.app_root, "src", "store.ts"), APP);
  writeFileSync(join(roots.evaluator_root, "checks", "check.txt"), CHECK);
  work = join(base, "work");
});

afterEach(async () => {
  await w.close();
});

function plan(overrides: Partial<CopyPlan> = {}): CopyPlan {
  return {
    copy_id: "synthetic-copy-buggy-01",
    host_id: "task-report",
    state: "buggy",
    image: { reference: "registry.invalid/synthetic/task-report-kit:1", digest: DIGEST },
    files: [{ path: "src/store.ts", sha256: sha256Hex(Buffer.from(APP)) }],
    evaluator_files: [{ path: "checks/check.txt", sha256: sha256Hex(Buffer.from(CHECK)) }],
    destinations: { app: "/workspace/app", evaluator: "/workspace/evaluator", results: "/workspace/results" },
    command: ["node", "/workspace/evaluator/run.ts", "--copy", "buggy"],
    limits: { timeout_s: 600, vcpus: 4, memory_mb: 8192, network: "none" },
    ...overrides,
  };
}

function meter(): CopyMeter {
  return new CopyMeter({
    ledger: w.ledger,
    identity: w.identity,
    rates: w.rates,
    now: w.clock.now,
    root: record.root,
    namespace: SYNTHETIC_REQUEST_NAMESPACE,
    task_revision: record.interpretation_sha256,
    budget_key: record.budget_key,
    provider: "vercel-sandbox",
    deadline: new Date(w.clock.ms + 3_600_000),
    margin_s: 120,
    mode: { kind: "own_operation", role: "request" },
    log: (line) => w.logs.push(line),
  });
}

function deps(overrides: Partial<SandboxRunnerDeps> = {}): SandboxRunnerDeps {
  return {
    sdk,
    meter: meter(),
    subject: CANDIDATE_A,
    workDir: work,
    resultsSha256: (dir) => Promise.resolve(sha256Hex(Buffer.from(readdirSync(dir).sort().join("\n")))),
    now: () => {
      w.clock.advance(1000);
      return w.clock.ms;
    },
    sleep: () => Promise.resolve(),
    attempt: "synthetic-attempt",
    log: (line) => w.logs.push(line),
    ...overrides,
  };
}

function opId(state: CopyPlan["state"] = "buggy"): string {
  return copyOperation({ identity: w.identity, rates: w.rates }, { namespace: SYNTHETIC_REQUEST_NAMESPACE, root: record.root, task_revision: record.interpretation_sha256, subject: CANDIDATE_A, state, n: 1, host: "task-report", provider: "vercel-sandbox" }).operation_id;
}

describe("the sandbox copy runner", () => {
  it("checks and places the files, runs the command once, brings the results back, confirms the stop and settles the copy", async () => {
    const collected = await createSandboxCopyRunner(deps()).run(plan(), roots);
    expect(collected).toMatchObject({ copy_id: "synthetic-copy-buggy-01", outcome: "ran", exit_code: 0, image_digest: DIGEST, architecture: "amd64" });
    expect(collected.results_dir).not.toBeNull();
    expect(readFileSync(join(collected.results_dir ?? "", "record.json"), "utf8")).toBe('{"synthetic":true}\n');
    expect(collected.results_sha256).toBe(sha256Hex(Buffer.from("record.json")));
    expect(Date.parse(collected.finished_at)).toBeGreaterThan(Date.parse(collected.started_at));

    expect(sdk.creates).toHaveLength(1);
    const create = sdk.creates[0];
    expect(create?.image).toBe(`registry.invalid/synthetic/task-report-kit@${DIGEST}`);
    expect(create?.networkPolicy).toBe("deny-all");
    expect(create?.resources.vcpus).toBe(4);
    expect(create?.timeout).toBe((600 + 60) * 1000);
    expect(create?.name).toMatch(/^rbw-fc-[0-9a-f-]{36}$/);
    const fs = sdk.files.get(create?.name ?? "");
    expect(fs?.get("/workspace/app/src/store.ts")?.toString()).toBe(APP);
    expect(fs?.get("/workspace/evaluator/checks/check.txt")?.toString()).toBe(CHECK);
    expect(sdk.commands.filter((command) => command.cmd === "node")).toHaveLength(1);
    expect(sdk.stops).toEqual([create?.name]);

    const status = await w.spend.operationStatus({ operation_id: opId() });
    expect(status.ok && status.state).toBe("reconciled");
    expect(status.ok && status.settled_microusd > 0n).toBe(true);
  });

  it("returns setup_failed without reserving or creating anything when a file is missing or has another sha256", async () => {
    for (const bad of [plan({ files: [{ path: "src/store.ts", sha256: "0".repeat(64) }] }), plan({ files: [{ path: "src/missing.ts", sha256: "0".repeat(64) }] }), plan({ evaluator_files: [{ path: "checks/check.txt", sha256: "1".repeat(64) }] })]) {
      expect((await createSandboxCopyRunner(deps()).run(bad, roots)).outcome).toBe("setup_failed");
    }
    expect(sdk.creates).toHaveLength(0);
    expect(await operationState(w, opId())).toBeNull();
  });

  it("returns setup_failed for a plan whose image is not pinned by digest", async () => {
    const collected = await createSandboxCopyRunner(deps()).run(plan({ image: { reference: "registry.invalid/synthetic/task-report-kit:1", digest: null } }), roots);
    expect(collected).toMatchObject({ outcome: "setup_failed", image_digest: NO_IMAGE_DIGEST, results_dir: null, results_sha256: null });
    expect(sdk.creates).toHaveLength(0);
    expect(pinnedImage(plan({ image: { reference: `registry.invalid/a/b@sha256:${"1".repeat(64)}`, digest: DIGEST } }))).toBeNull();
    expect(pinnedImage(plan({ image: { reference: "registry.invalid:5000/a/b", digest: DIGEST } }))).toBe(`registry.invalid:5000/a/b@${DIGEST}`);
  });

  it("refuses a plan above its host's copy limits through the meter, creating nothing", async () => {
    const collected = await createSandboxCopyRunner(deps()).run(plan({ limits: { timeout_s: 900, vcpus: 2, memory_mb: 4096, network: "none" } }), roots);
    expect(collected.outcome).toBe("setup_failed");
    expect(sdk.creates).toHaveLength(0);
    expect(await operationState(w, opId())).toBeNull();
  });

  it("gives a plan whose memory needs more vCPUs the vCPUs for it, and settles the size it created", async () => {
    expect(sandboxVcpus(plan({ limits: { timeout_s: 600, vcpus: 2, memory_mb: 8192, network: "none" } }))).toBe(4);
    const runner = createSandboxCopyRunner(deps());
    await runner.run(plan({ state: "clean", limits: { timeout_s: 600, vcpus: 2, memory_mb: 4096, network: "none" } }), roots);
    await runner.run(plan({ state: "fixed" }), roots);
    expect(sdk.creates.map((create) => create.resources.vcpus)).toEqual([2, 4]);
    const settled = async (state: CopyPlan["state"]) => {
      const status = await w.spend.operationStatus({ operation_id: opId(state) });
      if (!status.ok) throw new Error("synthetic: unknown operation");
      return Number(status.settled_microusd) - 1;
    };
    // The same lifetime at half the size settles half the compute and memory (each line rounded up).
    expect(Math.abs(2 * (await settled("clean")) - (await settled("fixed")))).toBeLessThanOrEqual(2);
  });

  it("rejects as uncertain, and never retries, when the create fails", async () => {
    sdk.createError = new Error("synthetic: the answer was lost");
    const runner = createSandboxCopyRunner(deps());
    await expect(runner.run(plan(), roots)).rejects.toThrow(SandboxCopyUncertain);
    expect(sdk.creates).toHaveLength(1);
    expect(await operationState(w, opId())).toBe("uncertain");
  });

  it("stops a sandbox it created when the ledger cannot record it, and rejects as uncertain", async () => {
    const transition = w.spend.transition.bind(w.spend);
    w.ledger.spend = { ...w.spend, transition: (request) => (request.to_state === "running" ? Promise.resolve({ ok: false as const, code: "invalid_transition" as const }) : transition(request)) };
    await expect(createSandboxCopyRunner(deps()).run(plan(), roots)).rejects.toThrow(SandboxCopyUncertain);
    expect(sdk.creates).toHaveLength(1);
    expect(sdk.stops).toEqual([sdk.creates[0]?.name]);
    expect(await operationState(w, opId())).toBe("uncertain");
  });

  it("counts the command's timeout from the create, as the provider does", async () => {
    const asked: number[] = [];
    const never = new AbortController().signal;
    await createSandboxCopyRunner(
      deps({
        timer: (ms) => {
          asked.push(ms);
          return never;
        },
      }),
    ).run(plan(), roots);
    expect(asked).toHaveLength(1);
    // The fake clock moves 1 s per reading: the create, then the setup reading before the command.
    expect(asked[0]).toBeLessThan(600_000);
    expect(asked[0]).toBeGreaterThan(590_000);
  });

  it("rejects as uncertain when the stop cannot be confirmed, keeping the reservation held", async () => {
    sdk.stopTakesEffect = false;
    await expect(createSandboxCopyRunner(deps()).run(plan(), roots)).rejects.toThrow(SandboxCopyUncertain);
    const status = await w.spend.operationStatus({ operation_id: opId() });
    expect(status.ok && [status.state, status.open_microusd > 0n]).toEqual(["uncertain", true]);
  });

  it("reports timed_out when the command passes its timeout, and still stops and settles the copy", async () => {
    const aborted = AbortSignal.abort();
    const collected = await createSandboxCopyRunner(deps({ timer: () => aborted })).run(plan(), roots);
    expect(collected).toMatchObject({ outcome: "timed_out", exit_code: null, results_dir: null, results_sha256: null });
    expect(sdk.stops).toHaveLength(1);
    expect(await operationState(w, opId())).toBe("reconciled");
  });

  it("returns setup_failed when the platform reports another image digest", async () => {
    sdk.reportedImage = `registry.invalid/synthetic/task-report-kit@sha256:${"0".repeat(64)}`;
    const collected = await createSandboxCopyRunner(deps()).run(plan(), roots);
    expect(collected.outcome).toBe("setup_failed");
    expect(sdk.commands).toHaveLength(0);
    expect(sdk.stops).toHaveLength(1);
  });

  it("keeps the exit code of a failing command and brings back no results from an archive with a link", async () => {
    sdk.copy = () => 1;
    expect(await createSandboxCopyRunner(deps()).run(plan(), roots)).toMatchObject({ outcome: "ran", exit_code: 1 });
    sdk.extraEntries = [{ name: "./escape", type: "symlink" }];
    const collected = await createSandboxCopyRunner(deps()).run(plan({ state: "fixed" }), roots);
    expect(collected).toMatchObject({ outcome: "ran", results_dir: null, results_sha256: null });
  });
});
