// A fake of the Vercel Sandbox SDK's surface that the sandbox backend uses. It records every call
// in order, keeps its sandboxes by name (so a lost create response can be recovered with `get`),
// and answers the copy command, the pack command and the archive read as each test configures.
import { Readable } from "node:stream";
import type { SandboxCommandParams, SandboxCreateParams, SandboxFile, SandboxInstance, SandboxSdk, SandboxStatus } from "../../src/sandbox.ts";
import { deferred } from "./fakes.ts";
import { tarOf } from "./synthetic.ts";
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
  /** The pack command's exit status (3 is the in-sandbox size refusal). */
  packExit?: number;
  /** Replaces the archive that readFile returns. */
  archive?: Buffer;
  /** Statuses `get` reports after stop, one per call; the last one repeats. */
  afterStop?: SandboxStatus[];
  /** The digest-pinned image the platform reports for a created sandbox. */
  reportedImage?: (requested: string) => string | undefined;
}

class FakeInstance implements SandboxInstance {
  readonly name: string;
  readonly image: string | undefined;
  readonly tags: Record<string, string> | undefined;
  status: SandboxStatus;
  archive: Buffer | null = null;
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

  async runCommand(params: SandboxCommandParams): Promise<{ wait(options?: { signal?: AbortSignal }): Promise<{ exitCode: number }> }> {
    this.sdk.calls.push({ op: "runCommand", name: this.name, params });
    const options = this.sdk.options;
    if (params.cmd === "/sbin/tini") {
      if (options.copyThrows !== undefined) throw new Error(options.copyThrows);
      const exit = options.copyExit === undefined ? (options.collected?.runExit ?? 0) : options.copyExit;
      if (exit === null) {
        const never = deferred<{ exitCode: number }>();
        return { wait: () => never.promise };
      }
      return { wait: () => Promise.resolve({ exitCode: exit }) };
    }
    const packExit = options.packExit ?? (options.collected === null ? 2 : 0);
    if (packExit === 0) this.archive = options.archive ?? (await this.sdk.packed());
    return { wait: () => Promise.resolve({ exitCode: packExit }) };
  }

  readFile(file: { path: string }): Promise<NodeJS.ReadableStream | null> {
    this.sdk.calls.push({ op: "readFile", name: this.name, path: file.path });
    return Promise.resolve(this.archive === null ? null : Readable.from([this.archive]));
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
