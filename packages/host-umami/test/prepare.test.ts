// The prepare step over a fake Docker layer that serves `docker cp` archives built here; no
// container is created or started for real.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@rbw/schema";
import type { Docker } from "@rbw/local-runner";
import { pack } from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import { buildUmamiAdapter } from "../src/adapter.ts";
import { UmamiRefusal } from "../src/errors.ts";
import { prepareStore } from "../src/prepare.ts";
import type { PlantedDerivation, PrepareOptions } from "../src/prepare.ts";
import { UMAMI_PINS } from "../src/pins.ts";
import type { UmamiPins } from "../src/pins.ts";
import { openStore } from "../src/store.ts";
import { SYNTHETIC_CLEAN_TARGET, SYNTHETIC_PLANTED_TARGET, cleanupTemp, recordingNewDir, repoFixture, syntheticSource, syntheticWorld, tempDir } from "./support.ts";

afterEach(cleanupTemp);

const MANIFEST = Buffer.from('{"schema":"synthetic-kit-manifest"}\n');

/** The synthetic world whose kit manifest is the one the fake image serves. */
const kitWorld = (): ReturnType<typeof syntheticWorld> => syntheticWorld({ kitSha256: sha256Hex(MANIFEST) });

interface Entry {
  name: string;
  content?: Buffer;
}

function tarOf(entries: readonly Entry[]): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: unknown) => {
    if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
  });
  const done = new Promise<Buffer>((resolve) => {
    archive.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
  });
  for (const entry of entries) {
    if (entry.content === undefined) archive.entry({ name: entry.name, type: "directory", mode: 0o755 });
    else archive.entry({ name: entry.name, type: "file", mode: 0o644 }, entry.content);
  }
  archive.finalize();
  return done;
}

interface FakeImage {
  digest: string;
  app: Record<string, string>;
  manifest: Buffer;
  fixture: Map<string, Buffer>;
}

function fakeImage(world: ReturnType<typeof syntheticWorld>): FakeImage {
  const fixture = new Map<string, Buffer>();
  const repo = repoFixture();
  for (const [path, sha] of Object.entries(repo.tree)) fixture.set(path, repo.bytes.get(sha) ?? Buffer.alloc(0));
  return { digest: world.pins.kit.digest, app: syntheticSource(), manifest: MANIFEST, fixture };
}

/** A Docker layer that serves the image's files as `docker cp` archives and records every command. */
function fakeDocker(image: FakeImage, commands: string[][]): Docker {
  const archives = async (path: string): Promise<Buffer | null> => {
    if (path === "/workspace/app") {
      const entries: Entry[] = [{ name: "app/" }];
      for (const [file, text] of Object.entries(image.app)) entries.push({ name: `app/${file}`, content: Buffer.from(text) });
      // What the kit adds that is not source: the export leaves each out.
      entries.push({ name: "app/node_modules/dep/index.js", content: Buffer.from("dependency\n") }, { name: "app/src/proxy.ts", content: Buffer.from("proxy\n") }, { name: "app/.next/" });
      return tarOf(entries);
    }
    if (path === "/opt/rbw/verifier/image-manifest.json") return tarOf([{ name: "image-manifest.json", content: image.manifest }]);
    if (path === "/opt/rbw/verifier/kit/umami-fixture") {
      const entries: Entry[] = [{ name: "umami-fixture/" }];
      for (const [file, bytes] of image.fixture) entries.push({ name: `umami-fixture/${file}`, content: bytes });
      entries.push({ name: "umami-fixture/node_modules/pkg/index.js", content: Buffer.from("x\n") }, { name: "umami-fixture/test-results/last-run.json", content: Buffer.from("{}\n") });
      return tarOf(entries);
    }
    return null;
  };
  return {
    async run(args, options = {}) {
      commands.push([...args]);
      const ok = (stdout = "") => ({ code: 0, stdout: Buffer.from(stdout), stderr: "", timedOut: false });
      if (args[0] === "image" && args[1] === "inspect") return ok(`${image.digest}\n`);
      if (args[0] === "create" || args[0] === "rm") return ok();
      if (args[0] === "cp" && options.stdout !== undefined) {
        const source = args[1] ?? "";
        const archive = await archives(source.slice(source.indexOf(":") + 1));
        if (archive === null) return { code: 1, stdout: Buffer.alloc(0), stderr: "no such path", timedOut: false };
        options.stdout.write(archive);
        options.stdout.end();
        return ok();
      }
      return { code: 1, stdout: Buffer.alloc(0), stderr: "unexpected command", timedOut: false };
    },
  };
}

const syntheticDerive: PlantedDerivation = (clean) => {
  if (clean.toString("utf8") !== SYNTHETIC_CLEAN_TARGET) throw new Error("not the synthetic clean target");
  const bytes = Buffer.from(SYNTHETIC_PLANTED_TARGET);
  return { sha256: sha256Hex(bytes), bytes };
};

function inputs(world: ReturnType<typeof syntheticWorld>): { suite: string; incident: string } {
  const dir = tempDir("rbw-host-umami-inputs-");
  writeFileSync(join(dir, "original-suite.json"), world.suiteBytes);
  writeFileSync(join(dir, "issue.json"), world.incidentBytes);
  return { suite: join(dir, "original-suite.json"), incident: join(dir, "issue.json") };
}

function options(world: ReturnType<typeof syntheticWorld>): PrepareOptions {
  const files = inputs(world);
  return { image: "synthetic-kit:local", dest: tempDir("rbw-host-umami-store-"), work: tempDir("rbw-host-umami-work-"), originalSuite: files.suite, incident: files.incident, container: "rbw-test-prepare" };
}

async function prepared(world: ReturnType<typeof syntheticWorld>, image: FakeImage, pins: UmamiPins = world.pins) {
  const commands: string[][] = [];
  const opts = options(world);
  const result = await prepareStore(fakeDocker(image, commands), opts, pins, syntheticDerive);
  return { result, commands, opts, pins };
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof UmamiRefusal) return error.code;
    throw error;
  }
  return "no refusal";
}

describe("prepareStore", () => {
  it("writes a store of the image's source (without the kit's non-source), its fixture, the planted file, the frozen suite and the incident", async () => {
    const world = kitWorld();
    const { result, pins } = await prepared(world, fakeImage(world));
    expect(result.index.source.files).toEqual(world.source);
    expect(result.index.fixture.files).toEqual(world.fixtureTree);
    expect(result.index.extra_objects).toEqual([world.pins.target.after_sha256]);
    const store = await openStore(result.dir, pins);
    expect(store.indexSha256).toBe(result.index_sha256);
    expect(sha256Hex(readFileSync(join(result.dir, "index.json")))).toBe(result.index_sha256);
    // The adapter serves the package inputs from it.
    const out = recordingNewDir();
    const adapter = buildUmamiAdapter(pins, { store: result.dir, newDir: out.newDir });
    const [entry] = adapter.catalog();
    if (entry === undefined) throw new Error("the catalog is empty");
    const bugCase = await adapter.bugCaseInputs(entry);
    expect(readFileSync(join(bugCase.source.root, ...pins.target.path.split("/")), "utf8")).toBe(SYNTHETIC_PLANTED_TARGET);
    await expect(adapter.validatorInputs(entry)).resolves.toMatchObject({ entry_id: entry.entry_id });
  });

  it("only creates, copies from and removes containers; it never starts one", async () => {
    const world = kitWorld();
    const { commands } = await prepared(world, fakeImage(world));
    expect(commands.map((args) => args[0])).toEqual(["image", "create", "cp", "cp", "rm", "create", "cp", "rm"]);
    expect(commands.filter((args) => args[0] === "create").every((args) => args.includes("--network") && args.includes("none"))).toBe(true);
  });

  it("refuses an image that is not the pinned one: digest, manifest, source tree or fixture", async () => {
    const world = kitWorld();
    const image = fakeImage(world);
    expect(await refusal(() => prepared(world, { ...image, digest: `sha256:${"9".repeat(64)}` }))).toBe("store_tree_mismatch");
    expect(await refusal(() => prepared(world, { ...image, manifest: Buffer.from("{}\n") }))).toBe("store_tree_mismatch");
    expect(await refusal(() => prepared(world, { ...image, app: { ...image.app, "README.md": "changed\n" } }))).toBe("store_tree_mismatch");
    const fixture = new Map(image.fixture);
    fixture.set("checks/extra.ts", Buffer.from("extra\n"));
    expect(await refusal(() => prepared(world, { ...image, fixture }))).toBe("store_tree_mismatch");
  });

  it("refuses a frozen suite or an incident that is not the pinned one, and writes nothing", async () => {
    const world = kitWorld();
    const image = fakeImage(world);
    const { pins } = world;
    for (const change of ["suite", "incident"] as const) {
      const opts = options(world);
      writeFileSync(change === "suite" ? opts.originalSuite : opts.incident, "{}\n");
      expect(await refusal(() => prepareStore(fakeDocker(image, []), opts, pins, syntheticDerive))).toBe("store_tree_mismatch");
      expect(await refusal(() => openStore(opts.dest, pins))).toBe("store_missing");
    }
  });

  it("refuses, without an unhandled rejection, when copying the fixture out of the image fails", async () => {
    const world = kitWorld();
    const image = fakeImage(world);
    const docker = fakeDocker(image, []);
    // The copy breaks off: a truncated archive, then a failing exit status.
    const truncated = (await tarOf([{ name: "umami-fixture/" }, { name: "umami-fixture/package.json", content: Buffer.alloc(4096, 0x61) }])).subarray(0, 1024);
    const failing: Docker = {
      run: (args, options) => {
        if (args[0] !== "cp" || args[1]?.endsWith("/umami-fixture") !== true || options?.stdout === undefined) return docker.run(args, options);
        options.stdout.write(truncated);
        options.stdout.end();
        return Promise.resolve({ code: 1, stdout: Buffer.alloc(0), stderr: "failed", timedOut: false });
      },
    };
    expect(await refusal(() => prepareStore(failing, options(world), world.pins, syntheticDerive))).toBe("store_invalid");
    // Give a late archive error the chance to surface as an unhandled rejection, which fails the run.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("derives the planted file with the probe set by default, which needs the image's real clean file", async () => {
    const world = kitWorld();
    const { pins } = world;
    // The synthetic clean file is not the pinned image's, so the default derivation refuses it.
    await expect(prepareStore(fakeDocker(fakeImage(world), []), options(world), pins)).rejects.toThrow(/base_hash_mismatch/);
  });
});

describe("prepare-cli", () => {
  it("removes its work directory when it refuses an input, after the export has filled it", async () => {
    const files = tempDir("rbw-host-umami-cli-");
    // A docker on PATH that serves the pinned digest, a one-file app tree and a manifest that is not the pinned one.
    writeFileSync(join(files, "app.tar"), await tarOf([{ name: "app/" }, { name: "app/README.md", content: Buffer.from("synthetic\n") }]));
    writeFileSync(join(files, "manifest.tar"), await tarOf([{ name: "image-manifest.json", content: MANIFEST }]));
    const script = ["#!/bin/sh", `echo "$*" >> '${files}/commands.log'`, 'case "$1 $2" in', `  "image inspect") echo '${UMAMI_PINS.kit.digest}' ;;`, `  "cp "*:/workspace/app) cat '${files}/app.tar' ;;`, `  "cp "*) cat '${files}/manifest.tar' ;;`, "esac", ""].join("\n");
    writeFileSync(join(files, "docker"), script, { mode: 0o755 });
    const temp = tempDir("rbw-host-umami-tmp-");
    const world = kitWorld();
    const { suite, incident } = inputs(world);
    const cli = fileURLToPath(new URL("../src/prepare-cli.ts", import.meta.url));
    const args = ["--image", "synthetic-kit:local", "--dest", join(files, "store"), "--original-suite", suite, "--incident", incident];
    const run = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${files}:${process.env.PATH ?? ""}`, TMPDIR: temp } });
    expect(run.stderr).toBe("refused store_tree_mismatch: image manifest is not the pinned one\n");
    expect(run.status).toBe(1);
    expect(readFileSync(join(files, "commands.log"), "utf8")).toMatch(/^cp \S+:\/workspace\/app -$/m);
    expect(readdirSync(temp)).toEqual([]);
  });
});
