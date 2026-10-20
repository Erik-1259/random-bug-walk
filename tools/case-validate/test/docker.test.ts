import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

const REFERENCE = "registry.invalid/synthetic/task-report-kit:1";
const PINNED = `sha256:${"a".repeat(64)}`;
const LOCAL_ID = `sha256:${"b".repeat(64)}`;
/** What `docker image inspect` prints with the runner's template: the image ID, the architecture and the repository digests as JSON. */
const inspect = (id: string, architecture: string, repoDigests: string[] | null = []): string => `${id} ${architecture} ${JSON.stringify(repoDigests)}`;
/** The pinned kit on a classic image store, where the image ID is the config digest, not the pinned manifest digest. */
const KIT = { [`${REFERENCE}@${PINNED}`]: inspect(LOCAL_ID, "amd64", [`registry.invalid/synthetic/task-report-kit@${PINNED}`]) };

function plan(overrides: Partial<CopyPlan> = {}): CopyPlan {
  return {
    copy_id: "synthetic-buggy-1",
    host_id: "task-report",
    state: "buggy",
    image: { reference: REFERENCE, digest: PINNED },
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
  /** `docker image inspect` answers per name (see `inspect`). */
  images: Record<string, string>;
  exit?: number;
  /** wait returns only when kill is called; with exitedFirst the copy had already ended and kill fails. */
  hang?: boolean;
  exitedFirst?: boolean;
  /** The kill fails although the copy overran its limit. */
  killFails?: boolean;
  results?: boolean | "fifo";
  createFails?: boolean;
  placeFails?: boolean;
  startFails?: boolean;
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
      return options.placeFails === true ? { code: 1, stdout: "", stderr: "cp failed" } : ok();
    }
    if (verb === "start" && options.startFails === true) return { code: 1, stdout: "", stderr: "start failed" };
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
    const docker = fakeDocker({ images: KIT });
    const collected = await dockerRunner({ command: docker.command, resultsDir: join(dir, "results") }).run(plan(), roots);
    expect(collected.outcome).toBe("ran");
    expect(collected.exit_code).toBe(0);
    // The daemon resolved the pinned digest itself, so the copy reports the pin, not the image ID.
    expect(collected.image_digest).toBe(PINNED);
    // A template every docker CLI version can execute (older ones cannot `join` RepoDigests).
    expect(docker.calls.find((call) => call[0] === "image")).toContain("{{.Id}} {{.Architecture}} {{json .RepoDigests}}");
    expect(collected.architecture).toBe("amd64");
    expect(collected.results_dir).not.toBeNull();
    expect(collected.results_sha256).toBe(await resultsSha256(collected.results_dir ?? ""));
    const create = docker.calls.find((call) => call[0] === "create") ?? [];
    expect(create).toEqual(expect.arrayContaining(["--network", "none", "--cpus", "1", "--memory", "512m"]));
    expect(create.slice(-3)).toEqual([`${REFERENCE}@${PINNED}`, "node", "/rbw/evaluator/run-copy.js"]);
    const placed = headers(docker.placed ?? new Uint8Array());
    expect(placed).toEqual([
      { name: "rbw/results/", typeflag: "5", mode: 0o777, bytes: "" },
      { name: "rbw/app/src/counter.js", typeflag: "0", mode: 0o644, bytes: "app\n" },
      { name: "rbw/evaluator/verify.js", typeflag: "0", mode: 0o644, bytes: "check\n" },
    ]);
    expect(docker.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("runs the tagged kit when the pinned reference is not on the daemon only if that image is the pin", async () => {
    // A locally built kit whose image ID is the pin.
    const local = fakeDocker({ images: { [REFERENCE]: inspect(PINNED, "arm64") } });
    const built = await dockerRunner({ command: local.command, resultsDir: join(dir, "results") }).run(plan(), roots);
    expect(built.outcome).toBe("ran");
    expect(built.image_digest).toBe(PINNED);
    expect(built.architecture).toBe("arm64");
    expect((local.calls.find((call) => call[0] === "create") ?? []).slice(-3)).toEqual([PINNED, "node", "/rbw/evaluator/run-copy.js"]);

    // A tagged image whose repository digests hold the pin.
    const pulled = fakeDocker({ images: { [REFERENCE]: inspect(LOCAL_ID, "amd64", [`registry.invalid/synthetic/other@sha256:${"c".repeat(64)}`, `registry.invalid/synthetic/task-report-kit@${PINNED}`]) } });
    const tagged = await dockerRunner({ command: pulled.command, resultsDir: join(dir, "results") }).run(plan(), roots);
    expect(tagged.outcome).toBe("ran");
    expect(tagged.image_digest).toBe(PINNED);

    // Any other image under the tag is never run.
    const other = fakeDocker({ images: { [REFERENCE]: inspect(LOCAL_ID, "amd64", [`registry.invalid/synthetic/task-report-kit@sha256:${"d".repeat(64)}`]) } });
    const refused = await dockerRunner({ command: other.command, resultsDir: join(dir, "results") }).run(plan(), roots);
    expect(refused.outcome).toBe("setup_failed");
    expect(other.calls.some((call) => call[0] === "create")).toBe(false);

    // An answer that is not the template's shape is no image either.
    const garbled = fakeDocker({ images: { [REFERENCE]: `${PINNED} amd64 not-json` } });
    expect((await dockerRunner({ command: garbled.command, resultsDir: join(dir, "results") }).run(plan(), roots)).outcome).toBe("setup_failed");
  });

  it("runs the image the caller chooses for a pinned plan only when that image is the pin, and reports the pin", async () => {
    // A stand-in whose image ID and repository digests are not the pin is never run.
    const standIn = fakeDocker({ images: { "synthetic-stand-in:1": inspect(LOCAL_ID, "arm64") } });
    const refused = await dockerRunner({ command: standIn.command, resultsDir: join(dir, "results"), image: () => "synthetic-stand-in:1" }).run(plan(), roots);
    expect(refused.outcome).toBe("setup_failed");
    expect(refused.image_digest).toBe(PINNED);
    expect(standIn.calls.some((call) => call[0] === "create")).toBe(false);

    // Another local name for the pinned image runs the image ID that was checked.
    const renamed = fakeDocker({ images: { "synthetic-local-kit:1": inspect(LOCAL_ID, "amd64", [`registry.invalid/synthetic/task-report-kit@${PINNED}`]) } });
    const chosen = await dockerRunner({ command: renamed.command, resultsDir: join(dir, "results"), image: () => "synthetic-local-kit:1" }).run(plan(), roots);
    expect(chosen.outcome).toBe("ran");
    expect(chosen.image_digest).toBe(PINNED);
    expect((renamed.calls.find((call) => call[0] === "create") ?? []).slice(-3)).toEqual([LOCAL_ID, "node", "/rbw/evaluator/run-copy.js"]);
    const built = fakeDocker({ images: { "synthetic-local-kit:1": inspect(PINNED, "arm64") } });
    expect((await dockerRunner({ command: built.command, resultsDir: join(dir, "results"), image: () => "synthetic-local-kit:1" }).run(plan(), roots)).image_digest).toBe(PINNED);
  });

  it("runs the image the caller chooses, or the reference, for a plan that pins no digest, and reports the image ID that ran", async () => {
    const standIn = fakeDocker({ images: { "synthetic-stand-in:1": inspect(LOCAL_ID, "arm64") } });
    const chosen = await dockerRunner({ command: standIn.command, resultsDir: join(dir, "results"), image: () => "synthetic-stand-in:1" }).run(plan({ image: { reference: REFERENCE, digest: null } }), roots);
    expect(chosen.outcome).toBe("ran");
    expect(chosen.image_digest).toBe(LOCAL_ID);
    expect((standIn.calls.find((call) => call[0] === "create") ?? []).slice(-3)).toEqual(["synthetic-stand-in:1", "node", "/rbw/evaluator/run-copy.js"]);

    const unpinned = fakeDocker({ images: { [REFERENCE]: inspect(LOCAL_ID, "amd64", null) } });
    const free = await dockerRunner({ command: unpinned.command, resultsDir: join(dir, "results") }).run(plan({ image: { reference: REFERENCE, digest: null } }), roots);
    expect(free.outcome).toBe("ran");
    expect(free.image_digest).toBe(LOCAL_ID);
  });

  it("is a setup failure, with no container, when a file differs from its hash or the image is missing", async () => {
    const docker = fakeDocker({ images: KIT });
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
    const docker = fakeDocker({ images: KIT, createFails: true });
    const collected = await dockerRunner({ command: docker.command }).run(plan(), roots);
    expect(collected.outcome).toBe("setup_failed");
    expect(collected.image_digest).toBe(PINNED);
  });

  it("kills the copy at its time limit and reports timed_out", async () => {
    const docker = fakeDocker({ images: KIT, hang: true });
    const collected = await dockerRunner({ command: docker.command, resultsDir: join(dir, "results") }).run(plan({ limits: { timeout_s: 1, vcpus: 1, memory_mb: 512, network: "none" } }), roots);
    expect(collected.outcome).toBe("timed_out");
    expect(collected.exit_code).toBeNull();
    expect(docker.calls.some((call) => call[0] === "kill")).toBe(true);
  });

  it("reports a copy that ended on its own just as the limit passed as ran, not timed_out", async () => {
    const docker = fakeDocker({ images: KIT, hang: true, exitedFirst: true });
    const collected = await dockerRunner({ command: docker.command, resultsDir: join(dir, "results") }).run(plan({ limits: { timeout_s: 1, vcpus: 1, memory_mb: 512, network: "none" } }), roots);
    expect(collected.outcome).toBe("ran");
    expect(collected.exit_code).toBe(0);
  });

  it("still reports timed_out when the kill fails but docker's record shows the copy overran its limit", async () => {
    const docker = fakeDocker({ images: KIT, hang: true, killFails: true });
    const collected = await dockerRunner({ command: docker.command, resultsDir: join(dir, "results") }).run(plan({ limits: { timeout_s: 1, vcpus: 1, memory_mb: 512, network: "none" } }), roots);
    expect(collected.outcome).toBe("timed_out");
  });

  it("is a setup failure, with no container, when the host cannot make the results directory", async () => {
    const docker = fakeDocker({ images: KIT });
    await writeFile(join(dir, "not-a-directory"), "x");
    const collected = await dockerRunner({ command: docker.command, resultsDir: join(dir, "not-a-directory") }).run(plan(), roots);
    expect(collected.outcome).toBe("setup_failed");
    expect(docker.calls.some((call) => call[0] === "create")).toBe(false);
  });

  it("answers no results, and never rejects, when the results hold a pipe", async () => {
    const docker = fakeDocker({ images: KIT, results: "fifo" });
    const collected = await dockerRunner({ command: docker.command, resultsDir: join(dir, "results") }).run(plan(), roots);
    expect(collected.outcome).toBe("ran");
    expect(collected.results_dir).toBeNull();
    expect(collected.results_sha256).toBeNull();
  });

  it("removes the copy's fresh results directory whenever it brings back no usable results, and keeps it when it does", async () => {
    const parent = join(dir, "results");
    const failures: FakeOptions[] = [
      { images: KIT, createFails: true },
      { images: KIT, placeFails: true },
      { images: KIT, startFails: true },
      { images: KIT, results: false },
      { images: KIT, results: "fifo" },
    ];
    for (const options of failures) {
      const collected = await dockerRunner({ command: fakeDocker(options).command, resultsDir: parent }).run(plan(), roots);
      expect(collected.results_dir).toBeNull();
      expect(await readdir(parent)).toEqual([]);
    }
    const kept = await dockerRunner({ command: fakeDocker({ images: KIT }).command, resultsDir: parent }).run(plan(), roots);
    const allocated = await readdir(parent);
    expect(allocated).toHaveLength(1);
    expect(dirname(kept.results_dir ?? "")).toBe(join(parent, allocated[0] ?? ""));
  });

  it("reports a non-zero exit as ran, and missing results as null", async () => {
    const docker = fakeDocker({ images: KIT, exit: 3, results: false });
    const collected = await dockerRunner({ command: docker.command, resultsDir: join(dir, "results") }).run(plan(), roots);
    expect(collected.outcome).toBe("ran");
    expect(collected.exit_code).toBe(3);
    expect(collected.results_dir).toBeNull();
    expect(collected.results_sha256).toBeNull();
  });
});
