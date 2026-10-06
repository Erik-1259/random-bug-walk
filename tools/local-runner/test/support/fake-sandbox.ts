// A fake of the Vercel Sandbox SDK's surface that the sandbox backend uses. It records every call
// in order, keeps its sandboxes by name (so a lost create response can be recovered with `get`),
// and answers the copy command, the pack command and the reads as each test configures. In shell
// mode it runs the real copy and pack scripts with /bin/sh under a temporary root, with a stub in
// place of the verifier's Node, so the copy script's own lock and completion marker are exercised.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { COPY_DONE } from "../../src/sandbox.ts";
import type { SandboxCommandParams, SandboxCreateParams, SandboxFile, SandboxInstance, SandboxSdk, SandboxStatus } from "../../src/sandbox.ts";
import { deferred } from "./fakes.ts";
import { tarOf, tempDir } from "./synthetic.ts";
import type { TarEntry } from "./synthetic.ts";

export type FakeCall =
  | { op: "create"; params: SandboxCreateParams }
  | { op: "get"; name: string }
  | { op: "writeFiles"; name: string; files: SandboxFile[] }
  | { op: "runCommand"; name: string; params: SandboxCommandParams }
  | { op: "readFile"; name: string; path: string }
  | { op: "stop"; name: string };

/** What the copy leaves in /var/lib/rbw/results/rbw-runner, as the fake packs it. */
export interface FakeCollected {
  freezeExit?: number | null;
  runExit?: number | null;
  /** A result file under out/results/<trial_id>/, as the driver writes it. */
  result?: boolean;
  /** Extra entries, relative to rbw-runner. */
  extra?: TarEntry[];
}

export interface FakeSandboxOptions {
  /** "lost": the sandbox is made but the response never arrives; "refused": nothing is made. */
  create?: "ok" | "lost" | "refused";
  /** The copy command's exit status; null means it never exits. */
  copyExit?: number | null;
  /** The copy command's runCommand rejects with this message, as the SDK does for a 4xx. */
  copyThrows?: string;
  collected?: FakeCollected | null;
  /** Reads of the completion marker that find nothing before it appears; null means it never appears. */
  markerAfter?: number | null;
  /** The status the completion marker records; by default the copy command's exit status. */
  markerExit?: number;
  /** Runs the real copy and pack scripts under a temporary root instead of answering from the options above. */
  shell?: ShellKit;
  /** The pack command's exit status (3 is the in-sandbox size refusal). */
  packExit?: number;
  /** Replaces the archive that readFile returns. */
  archive?: Buffer;
  /** Statuses `get` reports after stop, one per call; the last one repeats. */
  afterStop?: SandboxStatus[];
  /** The digest-pinned image the platform reports for a created sandbox. */
  reportedImage?: (requested: string) => string | undefined;
}

const STATE_ROOT = "/var/lib/rbw";
const VERIFIER_NODE = "/opt/rbw/verifier/node/bin/node";

export interface ShellKitOptions {
  freezeExit?: number;
  runExit?: number;
  /** Whole seconds the stub driver's run takes, so a second instance can start while it runs. */
  runSeconds?: number;
  /** How many times one runCommand starts the copy script, as the SDK's retry after a lost response does. */
  launches?: number;
  /** Which launch's handle runCommand returns. */
  handle?: "first" | "last";
}

export interface ShellRun {
  exit: Promise<number>;
  exited: () => boolean;
}

/** A temporary root that stands in for the sandbox's file system, and a stub driver that logs each call. */
export class ShellKit {
  readonly root = tempDir("rbw-fake-sandbox-");
  readonly options: ShellKitOptions;
  readonly runs: ShellRun[] = [];
  private readonly stub: string;
  private readonly log: string;

  constructor(options: ShellKitOptions = {}) {
    this.options = options;
    this.stub = join(this.root, "stub-node");
    this.log = join(this.root, "driver.log");
    writeFileSync(
      this.stub,
      [
        "#!/bin/sh",
        `echo "$2" >> ${this.log}`,
        `if [ "$2" = freeze ]; then exit ${String(options.freezeExit ?? 0)}; fi`,
        `sleep ${String(options.runSeconds ?? 0)}`,
        'mkdir -p "$8/results/$6" && echo "{}" > "$8/results/$6/trial-result.json"',
        `exit ${String(options.runExit ?? 0)}`,
        "",
      ].join("\n"),
    );
    chmodSync(this.stub, 0o755);
  }

  /** The script with the sandbox's state paths moved under the root and the verifier's Node replaced by the stub. */
  rewrite(script: string): string {
    return script.replaceAll(VERIFIER_NODE, this.stub).replaceAll(STATE_ROOT, join(this.root, STATE_ROOT));
  }

  /** Where a sandbox path lies under the root. */
  local(path: string): string {
    return path.startsWith(`${STATE_ROOT}/`) ? join(this.root, path) : join(this.root, "unmapped", path);
  }

  /** Starts `/bin/sh -c <rewritten script> ...args`. */
  start(script: string, args: readonly string[]): ShellRun {
    const child = spawn("/bin/sh", ["-c", this.rewrite(script), ...args], { cwd: this.root, stdio: "ignore", env: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
    const state = { exited: false };
    const exit = new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => {
        state.exited = true;
        resolve(code ?? -1);
      });
    });
    const run = { exit, exited: () => state.exited };
    this.runs.push(run);
    return run;
  }

  /** The stub driver's calls, in order. */
  driverCalls(): string[] {
    return existsSync(this.log) ? readFileSync(this.log, "utf8").split("\n").filter((line) => line !== "") : [];
  }
}

interface Handle {
  wait(options?: { signal?: AbortSignal }): Promise<{ exitCode: number }>;
}

class FakeInstance implements SandboxInstance {
  readonly name: string;
  readonly image: string | undefined;
  readonly tags: Record<string, string> | undefined;
  status: SandboxStatus;
  archive: Buffer | null = null;
  /** The copy command's exit status once it has exited, which the completion marker records. */
  copyExit: number | null = null;
  markerReads = 0;
  private readonly sdk: FakeSandboxSdk;

  constructor(sdk: FakeSandboxSdk, name: string, image: string | undefined, status: SandboxStatus, tags: Record<string, string> | undefined) {
    this.sdk = sdk;
    this.name = name;
    this.image = image;
    this.status = status;
    this.tags = tags;
  }

  writeFiles(files: SandboxFile[]): Promise<void> {
    this.sdk.calls.push({ op: "writeFiles", name: this.name, files });
    return Promise.resolve();
  }

  async runCommand(params: SandboxCommandParams): Promise<Handle> {
    this.sdk.calls.push({ op: "runCommand", name: this.name, params });
    const options = this.sdk.options;
    if (options.shell !== undefined) return this.runInShell(options.shell, params);
    if (params.cmd === "/sbin/tini") {
      if (options.copyThrows !== undefined) throw new Error(options.copyThrows);
      const exit = options.copyExit === undefined ? (options.collected?.runExit ?? 0) : options.copyExit;
      if (exit === null) {
        const never = deferred<{ exitCode: number }>();
        return { wait: () => never.promise };
      }
      this.copyExit = exit;
      return { wait: () => Promise.resolve({ exitCode: exit }) };
    }
    const packExit = options.packExit ?? (options.collected === null ? 2 : 0);
    if (packExit === 0) this.archive = options.archive ?? (await this.sdk.packed());
    return { wait: () => Promise.resolve({ exitCode: packExit }) };
  }

  private runInShell(kit: ShellKit, params: SandboxCommandParams): Handle {
    if (params.cmd === "/sbin/tini") {
      const [shell, flag, script, ...args] = params.args.slice(params.args.indexOf("--") + 1);
      if (shell !== "/bin/sh" || flag !== "-c" || script === undefined) throw new Error("synthetic: unexpected copy command");
      const launches = Array.from({ length: kit.options.launches ?? 1 }, () => kit.start(script, args));
      const handle = kit.options.handle === "first" ? launches[0] : launches.at(-1);
      if (handle === undefined) throw new Error("synthetic: no launch");
      return { wait: async () => ({ exitCode: await handle.exit }) };
    }
    const [flag, script] = params.args;
    if (params.cmd !== "/bin/sh" || flag !== "-c" || script === undefined) throw new Error("synthetic: unexpected command");
    const run = kit.start(script, ["rbw-pack"]);
    return { wait: async () => ({ exitCode: await run.exit }) };
  }

  readFile(file: { path: string }): Promise<NodeJS.ReadableStream | null> {
    this.sdk.calls.push({ op: "readFile", name: this.name, path: file.path });
    const kit = this.sdk.options.shell;
    if (kit !== undefined) {
      const local = kit.local(file.path);
      return Promise.resolve(existsSync(local) ? Readable.from([readFileSync(local)]) : null);
    }
    if (file.path === COPY_DONE) return Promise.resolve(this.marker());
    return Promise.resolve(this.archive === null ? null : Readable.from([this.archive]));
  }

  private marker(): NodeJS.ReadableStream | null {
    this.markerReads += 1;
    const after = this.sdk.options.markerAfter === undefined ? 0 : this.sdk.options.markerAfter;
    const exit = this.sdk.options.markerExit ?? this.copyExit;
    if (exit === null || after === null || this.markerReads <= after) return null;
    return Readable.from([Buffer.from(`${String(exit)}\n`)]);
  }

  stop(): Promise<unknown> {
    this.sdk.calls.push({ op: "stop", name: this.name });
    this.status = "stopping";
    this.sdk.stopped = true;
    return Promise.resolve({});
  }
}

export class FakeSandboxSdk implements SandboxSdk {
  readonly calls: FakeCall[] = [];
  readonly sandboxes = new Map<string, FakeInstance>();
  readonly options: FakeSandboxOptions;
  stopped = false;
  private trialId = "";
  private afterStopIndex = 0;

  constructor(options: FakeSandboxOptions = {}) {
    this.options = options;
  }

  /** A sandbox that already exists under `name`, for the name-collision case. */
  seed(name: string, status: SandboxStatus, tags?: Record<string, string>): void {
    this.sandboxes.set(name, new FakeInstance(this, name, undefined, status, tags));
  }

  create(params: SandboxCreateParams): Promise<SandboxInstance> {
    this.calls.push({ op: "create", params });
    this.trialId = params.name.split("-").slice(-2).join("-");
    if (this.sandboxes.has(params.name)) return Promise.reject(new Error("synthetic: a sandbox with this name exists"));
    const mode = this.options.create ?? "ok";
    if (mode === "refused") return Promise.reject(new Error("synthetic: create refused"));
    const reported = this.options.reportedImage === undefined ? params.image : this.options.reportedImage(params.image);
    const instance = new FakeInstance(this, params.name, reported, "running", params.tags);
    this.sandboxes.set(params.name, instance);
    if (mode === "lost") return Promise.reject(new Error("synthetic: the create response was lost"));
    return Promise.resolve(instance);
  }

  get(name: string): Promise<SandboxInstance | null> {
    this.calls.push({ op: "get", name });
    const instance = this.sandboxes.get(name);
    if (instance === undefined) return Promise.resolve(null);
    if (this.stopped) {
      const statuses = this.options.afterStop ?? ["stopped"];
      instance.status = statuses[Math.min(this.afterStopIndex, statuses.length - 1)] ?? "stopped";
      this.afterStopIndex += 1;
    }
    return Promise.resolve(instance);
  }

  /** The operations, in order, with the sandbox name left out. */
  ops(): string[] {
    return this.calls.map((call) => call.op);
  }

  async packed(): Promise<Buffer> {
    const collected = this.options.collected ?? {};
    const entries: TarEntry[] = [{ name: "./", type: "directory" }];
    if (collected.freezeExit !== null) entries.push({ name: "./freeze.exit", content: `${String(collected.freezeExit ?? 0)}\n` });
    if (collected.runExit !== null) entries.push({ name: "./run.exit", content: `${String(collected.runExit ?? 0)}\n` });
    if (collected.result !== false) entries.push({ name: `./out/results/${this.trialId}/trial-result.json`, content: "{}" });
    return tarOf([...entries, ...(collected.extra ?? [])]);
  }
}
