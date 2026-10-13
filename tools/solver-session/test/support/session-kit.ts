// A simulated kit container for session tests, behind the local runner's fake Docker layer and
// its synthetic kit inputs (the same app tree, probes, manifest and terms its tests use). The
// container's tracked files live in a map, so overlay, write_file and the submitted diff act on
// real bytes; the kit's scripts answer as the test configures them.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { CommandResult, RunOptions } from "@rbw/local-runner";
import { FakeClock, FakeDocker, failed, ok } from "../../../local-runner/test/support/fakes.ts";
import { HOST_COMMIT, SOURCE_FILES, appTree, sha256, tarOf, tempDir, writeAlternativeDir, writeProbeDir, writeTerms } from "../../../local-runner/test/support/synthetic.ts";
import type { TarEntry } from "../../../local-runner/test/support/synthetic.ts";
import { kitBuildOutputs } from "../../src/reset.ts";
import { LOG_SLICE_SCRIPT } from "../../src/session.ts";

export const IMAGE_ID = `sha256:${"7".repeat(64)}`;

export interface KitFile {
  bytes: Buffer;
  mode: number;
}

export interface SessionKitOptions {
  /** Extra entries in the image's app tree (for the export the audit reads). */
  extra?: readonly TarEntry[];
  /** The image's build-outputs.txt; the repository's by default. */
  buildOutputs?: string;
  /** rbw-start's answer per call (1-based); the default is a clean start. */
  start?: (call: number) => CommandResult;
  /** rbw-build-app's answer per call (1-based); the default builds. */
  build?: (call: number) => CommandResult;
  /** Changes the container's tracked files before each tracked read (after overlay). */
  tamper?: (files: Map<string, KitFile>) => void;
  /** `docker run`'s answer; the default creates the container. */
  run?: () => CommandResult;
  /** `docker rm`'s answer for a container; the default removes it. */
  rm?: (container: string) => CommandResult;
  /** rbw-check-cold's answer per call (1-based); the default is cold. */
  checkCold?: (call: number) => CommandResult;
  /** The source files (manifest, export and container); SOURCE_FILES by default. */
  sourceFiles?: Record<string, string>;
}

export const START_OK = "postgres_ready_ms=812\nready_ms=4210 budget_ms=60000 within_budget=yes\nlistening tcp 127.0.0.1:3000\nlistening tcp 127.0.0.1:5432\n";

export class SessionKit {
  readonly root = tempDir("rbw-solver-session-");
  readonly files = new Map<string, KitFile>();
  readonly logs = new Map<string, string>([
    ["/var/lib/rbw/logs/umami.stderr.log", ""],
    ["/var/lib/rbw/logs/postgres.stderr.log", ""],
  ]);
  readonly docker: FakeDocker;
  readonly clock = new FakeClock();
  /** The scripts the container ran, by their $0 name or command, in order. */
  readonly ran: string[] = [];
  /** Staged write_file contents, by their container path. */
  private readonly incoming = new Map<string, Buffer>();
  private readonly options: SessionKitOptions;
  private readonly sourceFiles: Record<string, string>;
  private colds = 0;
  private builds = 0;
  private starts = 0;

  constructor(options: SessionKitOptions = {}) {
    this.options = options;
    this.sourceFiles = options.sourceFiles ?? SOURCE_FILES;
    for (const [path, content] of Object.entries(this.sourceFiles)) this.files.set(path, { bytes: Buffer.from(content), mode: 0o644 });
    this.docker = new FakeDocker((args, runOptions) => this.handle(args, runOptions));
  }

  /** Session options over the synthetic inputs. */
  inputs(): { manifest: string; terms: string; policy: null; probesDir: string; alternativeDir: string } {
    const files = Object.entries(this.sourceFiles)
      .map(([path, content]) => ({ mode: "100644", path, sha256: sha256(content), size_bytes: Buffer.byteLength(content) }))
      .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    const manifest = join(this.root, "manifest.json");
    writeFileSync(manifest, JSON.stringify({ files, host_commit: HOST_COMMIT }));
    return { manifest, terms: writeTerms(this.root), policy: null, probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir() };
  }

  private async handle(args: readonly string[], options: RunOptions): Promise<CommandResult> {
    const [command] = args;
    if (command === "image") return ok(`${IMAGE_ID}\n`);
    if (command === "run") return this.options.run?.() ?? ok();
    if (command === "rm") return this.options.rm?.(String(args.at(-1))) ?? ok();
    if (command === "create") return ok();
    if (command === "cp") return this.copy(args.map(String), options);
    if (command === "exec") return this.exec(args.slice(4).map(String), options);
    return failed(125, `unexpected docker command ${args.join(" ")}`);
  }

  private async copy([, from, to]: string[], options: RunOptions): Promise<CommandResult> {
    if (from === undefined || to === undefined) return failed(1);
    if (to === "-") {
      const stream = options.stdout as Writable;
      const bytes = from.endsWith(":/workspace/app") ? await appTree(this.options.extra ?? [], this.sourceFiles) : await tarOf([{ name: "image-manifest.json", content: '{"synthetic":"image manifest"}', mode: 0o600 }]);
      stream.end(bytes);
      return ok();
    }
    const staging = /:(\/var\/lib\/rbw\/session\/incoming-\d+)$/.exec(to);
    if (staging?.[1] !== undefined) {
      this.incoming.set(staging[1], readFileSync(from));
      return ok();
    }
    if (from.endsWith(":/var/lib/rbw/logs")) return ok();
    return failed(1, `unexpected cp ${from} ${to}`);
  }

  private async exec(command: string[], options: RunOptions): Promise<CommandResult> {
    const [program] = command;
    if (program === "/bin/sh") return this.script(String(command[3]), command.slice(4), options);
    if (program === "cat") {
      this.ran.push("cat-build-outputs");
      return ok(this.options.buildOutputs ?? kitBuildOutputs().text);
    }
    if (program === "install") return ok();
    if (program === "/opt/rbw/bin/rbw-launch") return this.launch(command.slice(command.indexOf("--") + 1));
    const name = String(program).replace("/opt/rbw/bin/", "");
    this.ran.push(name);
    if (name === "rbw-stop") return ok();
    if (name === "rbw-check-cold") {
      this.colds += 1;
      return this.options.checkCold?.(this.colds) ?? ok();
    }
    if (name === "rbw-build-app") {
      this.builds += 1;
      return this.options.build?.(this.builds) ?? ok("--- build stdout\ncompiled\nbuild_exit=0\n");
    }
    if (name === "rbw-start") {
      this.starts += 1;
      return this.options.start?.(this.starts) ?? ok(START_OK);
    }
    return failed(127, `unexpected exec ${command.join(" ")}`);
  }

  private async script(name: string, rest: string[], options: RunOptions): Promise<CommandResult> {
    this.ran.push(name);
    if (name === "rbw-snapshot" || name === "rbw-reset" || name === "rbw-kill-app") return ok();
    if (name === "rbw-place") {
      const [app, path, staging] = rest.map(String);
      const file = this.files.get(String(path));
      const incoming = this.incoming.get(String(staging));
      this.incoming.delete(String(staging));
      if (app !== "/workspace/app" || file === undefined || incoming === undefined) return failed(3, "not a regular file");
      file.bytes = incoming;
      return ok(`${createHash("sha256").update(incoming).digest("hex")}  /workspace/app/${String(path)}\n`);
    }
    if (name === "rbw-tracked") {
      this.options.tamper?.(this.files);
      const entries: TarEntry[] = [];
      if (rest[0] !== "/workspace/app" || rest[1] !== "/var/lib/rbw/session/tracked.list") return failed(2, `unexpected tracked-read arguments ${rest.slice(0, 2).join(" ")}`);
      for (const path of rest.slice(2)) {
        const file = this.files.get(path);
        if (file !== undefined) entries.push({ name: path, content: file.bytes.toString("utf8"), mode: file.mode });
      }
      (options.stdout as Writable).end(await tarOf(entries));
      return ok();
    }
    if (name === "rbw-log") {
      // The real slice script, over a copy of the simulated log.
      const [file, offset, max] = rest.map(String);
      const copy = join(this.root, "log-slice.log");
      writeFileSync(copy, this.logs.get(String(file)) ?? "");
      const result = spawnSync("/bin/sh", ["-c", LOG_SLICE_SCRIPT, "rbw-log", copy, String(offset), String(max)]);
      return { code: result.status, stdout: result.stdout, stderr: result.stderr.toString("utf8"), timedOut: false };
    }
    return failed(127, `unexpected script ${name}`);
  }

  private launch(command: string[]): CommandResult {
    this.ran.push(`launch:${command[0] ?? ""}`);
    if (command[0] === "head") {
      const path = String(command[4]).replace("/workspace/app/", "");
      const file = this.files.get(path);
      if (file === undefined) return failed(1, `head: ${String(command[4])}: No such file or directory`);
      return ok(file.bytes.subarray(0, Number(command[2])));
    }
    if (command[2] === "sleep 999") return { code: 124, stdout: Buffer.alloc(0), stderr: "rbw-launch: timed out after 120000 ms\n", timedOut: false };
    return ok(`ran: ${String(command[2])}\n`);
  }

  /** The exec argument lists the session sent, without `exec --user 0:0 <container>`. */
  execs(): string[][] {
    return this.docker.named("exec").map((call) => call.slice(4));
  }
}
