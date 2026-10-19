import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultsSha256 } from "@rbw/case-package";
import type { CopyPlan, CopyRoots } from "@rbw/factory-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dockerRunner, type CommandResult, type DockerCommand } from "../src/docker.ts";
import { sha, text } from "./support.ts";

let dir: string;
let roots: CopyRoots;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "case-validate-docker-"));
  roots = { app_root: join(dir, "app"), evaluator_root: join(dir, "evaluator") };
  await mkdir(join(roots.app_root, "src"), { recursive: true });
  await mkdir(roots.evaluator_root, { recursive: true });
  await writeFile(join(roots.app_root, "src/counter.js"), "app\n");
  await writeFile(join(roots.evaluator_root, "verify.js"), "check\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PINNED = `sha256:${"a".repeat(64)}`;
const LOCAL_ID = `sha256:${"b".repeat(64)}`;

function plan(overrides: Partial<CopyPlan> = {}): CopyPlan {
  return {
    copy_id: "synthetic-buggy-1",
    host_id: "task-report",
    state: "buggy",
    image: { reference: "registry.invalid/synthetic/task-report-kit:1", digest: PINNED },
    files: [{ path: "src/counter.js", sha256: sha(text("app\n")) }],
    evaluator_files: [{ path: "verify.js", sha256: sha(text("check\n")) }],
    destinations: { app: "/rbw/app", evaluator: "/rbw/evaluator", results: "/rbw/results" },
    command: ["node", "/rbw/evaluator/run-copy.js"],
    limits: { timeout_s: 30, vcpus: 1, memory_mb: 512, network: "none" },
    ...overrides,
  };
}

interface TarHeader {
  name: string;
  typeflag: string;
  mode: number;
  bytes: string;
}

/** Reads ustar headers (short names only), including the directory entries the runner writes. */
function headers(tar: Uint8Array): TarHeader[] {
  const out: TarHeader[] = [];
  const decode = (from: number, length: number): string => new TextDecoder().decode(tar.subarray(from, from + length)).replace(/\0.*$/s, "");
  let offset = 0;
  while (offset + 512 <= tar.length && tar.subarray(offset, offset + 512).some((byte) => byte !== 0)) {
    const size = Number.parseInt(decode(offset + 124, 12), 8);
    out.push({ name: decode(offset, 100), typeflag: decode(offset + 156, 1), mode: Number.parseInt(decode(offset + 100, 8), 8), bytes: decode(offset + 512, size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

interface FakeDocker {
  command: DockerCommand;
  calls: string[][];
  placed: Uint8Array | null;
}

interface FakeOptions {
  images: Record<string, string>;
  exit?: number;
  /** wait returns only when kill is called; with exitedFirst the copy had already ended and kill fails. */
  hang?: boolean;
  exitedFirst?: boolean;
  /** The kill fails although the copy overran its limit. */
  killFails?: boolean;
  results?: boolean | "fifo";
  createFails?: boolean;
}

function fakeDocker(options: FakeOptions): FakeDocker {
  const fake: FakeDocker = { command: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }), calls: [], placed: null };
  let release: ((result: CommandResult) => void) | null = null;
  fake.command = async (args, command) => {
    fake.calls.push([...args]);
    const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
    const [verb] = args;
    if (verb === "image") {
      const id = options.images[args.at(-1) ?? ""];
      return id === undefined ? { code: 1, stdout: "", stderr: "no such image" } : ok(`${id}\n`);
    }
    if (verb === "create") return options.createFails === true ? { code: 125, stdout: "", stderr: "create failed" } : ok("container\n");
    if (verb === "cp" && args[1] === "-") {
      fake.placed = command.input ?? null;
      return ok();
    }
    if (verb === "cp") {
      if (options.results === false) return { code: 1, stdout: "", stderr: "no results" };
      const target = args[2] ?? "";
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "copy.json"), "{}\n");
      if (options.results === "fifo") {
        await new Promise<void>((resolve, reject) => {
          execFile("mkfifo", [join(target, "pipe")], (error) => {
            if (error === null) resolve();
            else reject(new Error(`mkfifo failed: ${error.message}`));
          });
        });
      }
      return ok();
    }
    if (verb === "wait") {
      if (options.hang === true) return new Promise((resolve) => (release = resolve));
      return ok(`${String(options.exit ?? 0)}\n`);
    }
    if (verb === "kill") {
      if (options.killFails === true) {
        release?.({ code: 0, stdout: "0\n", stderr: "" });
        return { code: 1, stdout: "", stderr: "daemon error" };
      }
      if (options.exitedFirst === true) {
        release?.({ code: 0, stdout: "0\n", stderr: "" });
        return { code: 1, stdout: "", stderr: "container is not running" };
      }
      release?.({ code: 0, stdout: "137\n", stderr: "" });
      return ok();
    }
    if (verb === "inspect") {
      // docker's record of the run: just under the one-second limit when the copy ended on its own.
      const finished = options.exitedFirst === true ? "2026-10-19T12:00:00.950123456Z" : "2026-10-19T12:00:01.020123456Z";
      return ok(`2026-10-19T12:00:00.000123456Z ${finished}\n`);
    }
    return ok();
  };
  return fake;
}

describe("dockerRunner", () => {
  it("places every file at its destination, runs without network within the limits and brings the results back hashed", async () => {
    const docker = fakeDocker({ images: { [`registry.invalid/synthetic/task-report-kit:1@${PINNED}`]: `${LOCAL_ID} amd64` } });
    const collected = await dockerRunner({ command: docker.command, resultsDir: join(dir, "results") }).run(plan(), roots);
    expect(collected.outcome).toBe("ran");
    expect(collected.exit_code).toBe(0);
    expect(collected.image_digest).toBe(LOCAL_ID);
    expect(collected.architecture).toBe("amd64");
    expect(collected.results_dir).not.toBeNull();
    expect(collected.results_sha256).toBe(await resultsSha256(collected.results_dir ?? ""));
    const create = docker.calls.find((call) => call[0] === "create") ?? [];
    expect(create).toEqual(expect.arrayContaining(["--network", "none", "--cpus", "1", "--memory", "512m"]));
    expect(create.slice(-3)).toEqual([`registry.invalid/synthetic/task-report-kit:1@${PINNED}`, "node", "/rbw/evaluator/run-copy.js"]);
    const placed = headers(docker.placed ?? new Uint8Array());
    expect(placed).toEqual([
      { name: "rbw/results/", typeflag: "5", mode: 0o777, bytes: "" },
      { name: "rbw/app/src/counter.js", typeflag: "0", mode: 0o644, bytes: "app\n" },
      { name: "rbw/evaluator/verify.js", typeflag: "0", mode: 0o644, bytes: "check\n" },
    ]);
    expect(docker.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("runs a locally built kit when the pinned digest is not on the daemon, and reports the image that ran", async () => {
    const docker = fakeDocker({ images: { "registry.invalid/synthetic/task-report-kit:1": `${LOCAL_ID} arm64` } });
    const collected = await dockerRunner({ command: docker.command, resultsDir: join(dir, "results") }).run(plan(), roots);
    expect(collected.outcome).toBe("ran");
    expect(collected.image_digest).toBe(LOCAL_ID);
    expect(collected.architecture).toBe("arm64");
  });

  it("is a setup failure, with no container, when a file differs from its hash or the image is missing", async () => {
    const docker = fakeDocker({ images: { "registry.invalid/synthetic/task-report-kit:1": `${LOCAL_ID} amd64` } });
    const tampered = await dockerRunner({ command: docker.command }).run(plan({ files: [{ path: "src/counter.js", sha256: "0".repeat(64) }] }), roots);
    expect(tampered.outcome).toBe("setup_failed");
    expect(tampered.results_dir).toBeNull();
    const missing = fakeDocker({ images: {} });
    const noImage = await dockerRunner({ command: missing.command }).run(plan(), roots);
    expect(noImage.outcome).toBe("setup_failed");
    expect(noImage.image_digest).toBe(PINNED);
    expect([...docker.calls, ...missing.calls].some((call) => call[0] === "create")).toBe(false);
  });

  it("is a setup failure when the container cannot be created", async () => {
    const docker = fakeDocker({ images: { "registry.invalid/synthetic/task-report-kit:1": `${LOCAL_ID} amd64` }, createFails: true });
    const collected = await dockerRunner({ command: docker.command }).run(plan(), roots);
    expect(collected.outcome).toBe("setup_failed");
    expect(collected.image_digest).toBe(LOCAL_ID);
  });

  it("kills the copy at its time limit and reports timed_out", async () => {
    const docker = fakeDocker({ images: { "registry.invalid/synthetic/task-report-kit:1": `${LOCAL_ID} amd64` }, hang: true });
    const collected = await dockerRunner({ command: docker.command, resultsDir: join(dir, "results") }).run(plan({ limits: { timeout_s: 1, vcpus: 1, memory_mb: 512, network: "none" } }), roots);
    expect(collected.outcome).toBe("timed_out");
    expect(collected.exit_code).toBeNull();
    expect(docker.calls.some((call) => call[0] === "kill")).toBe(true);
  });

  it("reports a copy that ended on its own just as the limit passed as ran, not timed_out", async () => {
    const docker = fakeDocker({ images: { "registry.invalid/synthetic/task-report-kit:1": `${LOCAL_ID} amd64` }, hang: true, exitedFirst: true });
    const collected = await dockerRunner({ command: docker.command, resultsDir: join(dir, "results") }).run(plan({ limits: { timeout_s: 1, vcpus: 1, memory_mb: 512, network: "none" } }), roots);
    expect(collected.outcome).toBe("ran");
    expect(collected.exit_code).toBe(0);
  });

  it("still reports timed_out when the kill fails but docker's record shows the copy overran its limit", async () => {
    const docker = fakeDocker({ images: { "registry.invalid/synthetic/task-report-kit:1": `${LOCAL_ID} amd64` }, hang: true, killFails: true });
    const collected = await dockerRunner({ command: docker.command, resultsDir: join(dir, "results") }).run(plan({ limits: { timeout_s: 1, vcpus: 1, memory_mb: 512, network: "none" } }), roots);
    expect(collected.outcome).toBe("timed_out");
  });

  it("is a setup failure, with no container, when the host cannot make the results directory", async () => {
    const docker = fakeDocker({ images: { "registry.invalid/synthetic/task-report-kit:1": `${LOCAL_ID} amd64` } });
    await writeFile(join(dir, "not-a-directory"), "x");
    const collected = await dockerRunner({ command: docker.command, resultsDir: join(dir, "not-a-directory") }).run(plan(), roots);
    expect(collected.outcome).toBe("setup_failed");
    expect(docker.calls.some((call) => call[0] === "create")).toBe(false);
  });

  it("answers no results, and never rejects, when the results hold a pipe", async () => {
    const docker = fakeDocker({ images: { "registry.invalid/synthetic/task-report-kit:1": `${LOCAL_ID} amd64` }, results: "fifo" });
    const collected = await dockerRunner({ command: docker.command, resultsDir: join(dir, "results") }).run(plan(), roots);
    expect(collected.outcome).toBe("ran");
    expect(collected.results_dir).toBeNull();
    expect(collected.results_sha256).toBeNull();
  });

  it("reports a non-zero exit as ran, and missing results as null", async () => {
    const docker = fakeDocker({ images: { "registry.invalid/synthetic/task-report-kit:1": `${LOCAL_ID} amd64` }, exit: 3, results: false });
    const collected = await dockerRunner({ command: docker.command, resultsDir: join(dir, "results") }).run(plan(), roots);
    expect(collected.outcome).toBe("ran");
    expect(collected.exit_code).toBe(3);
    expect(collected.results_dir).toBeNull();
    expect(collected.results_sha256).toBeNull();
  });
});
