// The `./prepare` entry: builds the prepared store on a host with Docker, from the pinned kit
// image (the local runner's export path) plus the frozen original-suite manifest and the released
// incident. Nothing here runs a container: the image's files are read from containers that are
// created and never started. Every input is checked against the pins before the store is written.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveCodeStates, exportImage, inspectImage } from "@rbw/local-runner";
import type { Docker } from "@rbw/local-runner";
import { sha256Hex } from "@rbw/schema";
import { PROBE_DIR, loadProbeSet } from "@rbw/shapes";
import { extract } from "tar-stream";
import { UmamiRefusal } from "./errors.ts";
import { suiteTestIds } from "./inputs.ts";
import { checkTestIds } from "./job.ts";
import { UMAMI_PINS } from "./pins.ts";
import type { UmamiPins } from "./pins.ts";
import { STORE_FORMAT, isRelativePath, writeStore } from "./store.ts";
import type { StoreIndex } from "./store.ts";
import { treeSha256 } from "./tree.ts";

/** Where the kit image holds the fixture package it runs. */
export const IMAGE_FIXTURE_DIR = "/opt/rbw/verifier/kit/umami-fixture";
/** For each docker command, as the local runner bounds its own. */
const COMMAND_TIMEOUT_MS = 300_000;

export interface PrepareOptions {
  /** The kit image to read from: a local reference whose content digest is the pinned one. */
  image: string;
  /** The store's directory: new or empty. */
  dest: string;
  /** A new scratch directory for the exported source. */
  work: string;
  /** The frozen original-suite manifest that a freeze copy of the image wrote. */
  originalSuite: string;
  /** The released incident file (issue.json). */
  incident: string;
  /** A name prefix for the two never-started containers. */
  container: string;
}

export interface PreparedResult {
  dir: string;
  index: StoreIndex;
  index_sha256: string;
}

function refuse(what: string): never {
  throw new UmamiRefusal("store_tree_mismatch", `${what} is not the pinned one`);
}

/** Every regular file under a directory, by relative path; a symbolic link or other entry is refused. */
export function hashDirectory(root: string): { tree: Record<string, string>; bytes: Map<string, Buffer> } {
  const tree: Record<string, string> = {};
  const bytes = new Map<string, Buffer>();
  const visit = (prefix: string): void => {
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const content = readFileSync(join(root, path));
        const sha256 = sha256Hex(content);
        tree[path] = sha256;
        bytes.set(sha256, content);
      } else throw new UmamiRefusal("store_invalid", `${path} is neither a file nor a directory`);
    }
  };
  visit("");
  return { tree, bytes };
}

/**
 * The image's fixture package as the driver hashes it (fixture.ts addedSuiteSha256): every file,
 * leaving out node_modules and the top-level test-results directory.
 */
export async function readImageFixture(docker: Docker, image: string, container: string): Promise<{ tree: Record<string, string>; bytes: Map<string, Buffer> }> {
  const created = await docker.run(["create", "--name", container, "--network", "none", image], { timeoutMs: COMMAND_TIMEOUT_MS });
  if (created.code !== 0) throw new UmamiRefusal("store_invalid", "docker create failed for the fixture container");
  const tree: Record<string, string> = {};
  const bytes = new Map<string, Buffer>();
  const failure: { error: Error | null } = { error: null };
  try {
    const archive = extract();
    archive.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: unknown) => {
        if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
        else failure.error ??= new UmamiRefusal("store_invalid", "the fixture archive streamed a non-byte chunk");
      });
      stream.on("end", () => {
        const name = header.name.replace(/\/+$/, "");
        const path = name === "umami-fixture" ? "" : name.startsWith("umami-fixture/") ? name.slice("umami-fixture/".length) : null;
        const skipped = path !== null && (path.split("/").includes("node_modules") || path === "test-results" || path.startsWith("test-results/"));
        if (path === null || (path !== "" && !isRelativePath(path))) failure.error ??= new UmamiRefusal("store_invalid", "the fixture archive has an unsafe entry");
        else if (!skipped && header.type === "file") {
          const content = Buffer.concat(chunks);
          tree[path] = sha256Hex(content);
          bytes.set(sha256Hex(content), content);
        } else if (!skipped && header.type !== "directory") failure.error ??= new UmamiRefusal("store_invalid", `the fixture holds a ${header.type} entry`);
        next();
      });
      stream.resume();
    });
    // The extractor's outcome as a value, so an archive error after a failed copy is never an unhandled rejection.
    const finished = new Promise<Error | null>((resolve) => {
      archive.on("finish", () => {
        resolve(null);
      });
      archive.on("error", (error: Error) => {
        resolve(error);
      });
    });
    const copied = await docker.run(["cp", `${container}:${IMAGE_FIXTURE_DIR}`, "-"], { stdout: archive, timeoutMs: COMMAND_TIMEOUT_MS });
    if (copied.code !== 0) {
      archive.destroy();
      throw new UmamiRefusal("store_invalid", "docker cp of the fixture failed");
    }
    const extractError = await finished;
    if (extractError !== null) throw new UmamiRefusal("store_invalid", `the fixture archive could not be read (${extractError.message})`);
  } finally {
    await docker.run(["rm", "--force", container], { timeoutMs: COMMAND_TIMEOUT_MS });
  }
  if (failure.error !== null) throw failure.error;
  return { tree, bytes };
}

/** Makes the planted target file from the image's clean one. */
export type PlantedDerivation = (clean: Buffer) => { sha256: string; bytes: Buffer };

/** The planted file exactly as the local runner derives it: the probe set's mutation patch on the clean file, hash-checked. */
export const derivePlanted: PlantedDerivation = (clean) => {
  const planted = deriveCodeStates(clean, loadProbeSet(PROBE_DIR), null).get("planted");
  if (planted === undefined) throw new UmamiRefusal("store_invalid", "the probe set gives no planted state");
  return { sha256: planted.sha256, bytes: planted.bytes };
};

export async function prepareStore(docker: Docker, options: PrepareOptions, pins: UmamiPins = UMAMI_PINS, derive: PlantedDerivation = derivePlanted): Promise<PreparedResult> {
  if ((await inspectImage(docker, options.image)) !== pins.kit.digest) refuse("image's content digest");
  const exported = await exportImage(docker, { image: options.image, container: `${options.container}-app`, dest: join(options.work, "source") });
  if (sha256Hex(exported.image_manifest) !== pins.kit.kit_sha256) refuse("image manifest");
  const source = hashDirectory(exported.source_dir);
  if (treeSha256(source.tree) !== pins.kit.source_tree_sha256) refuse("image's source tree");
  const fixture = await readImageFixture(docker, options.image, `${options.container}-fixture`);
  if (treeSha256(fixture.tree) !== pins.kit.added_suite_sha256) refuse("image's fixture");

  // The planted target, derived from the image's clean file.
  const clean = readFileSync(join(exported.source_dir, ...pins.target.path.split("/")));
  if (sha256Hex(clean) !== pins.target.before_sha256) refuse("clean target file");
  const planted = derive(clean);
  if (planted.sha256 !== pins.target.after_sha256 || sha256Hex(planted.bytes) !== planted.sha256) refuse("planted target file");

  const suite = readFileSync(options.originalSuite);
  if (sha256Hex(suite) !== pins.original_suite.sha256) refuse("frozen original suite");
  checkTestIds(pins, suiteTestIds(suite));
  const incident = readFileSync(options.incident);
  if (sha256Hex(incident) !== pins.incident.sha256) refuse("incident");

  const objects = new Map<string, Uint8Array>([...source.bytes, ...fixture.bytes]);
  objects.set(planted.sha256, planted.bytes);
  objects.set(sha256Hex(suite), suite);
  objects.set(sha256Hex(incident), incident);
  const index: StoreIndex = {
    format: STORE_FORMAT,
    host_id: "umami",
    kit_image_digest: pins.kit.digest,
    kit_sha256: pins.kit.kit_sha256,
    source: { tree_sha256: treeSha256(source.tree), files: source.tree },
    fixture: { tree_sha256: treeSha256(fixture.tree), files: fixture.tree },
    original_suite: { sha256: sha256Hex(suite) },
    incident: { sha256: sha256Hex(incident) },
    extra_objects: [planted.sha256],
  };
  const indexSha256 = await writeStore(options.dest, index, objects);
  return { dir: options.dest, index, index_sha256: indexSha256 };
}
