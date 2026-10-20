// The prepared store: the pinned inputs that the image export path prepares on a host with Docker
// (src/prepare.ts), kept by content hash. `objects/<sha256>` holds each distinct file once;
// `index.json` (canonical JSON) lists the trees and single files by path and hash. The adapter
// reads the store and never writes to it: every tree it hands out is materialized into a new
// directory, each object's bytes checked against its name on the way.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CanonicalError, encodeCanonical, parseCanonical, sha256Hex } from "@rbw/schema";
import { UmamiRefusal } from "./errors.ts";
import type { UmamiPins } from "./pins.ts";
import { treeSha256 } from "./tree.ts";
import type { Tree } from "./tree.ts";

export const STORE_FORMAT = "rbw-host-umami-store/1";
export const INDEX_FILE = "index.json";
export const OBJECTS_DIR = "objects";

export interface StoreIndex {
  format: typeof STORE_FORMAT;
  host_id: "umami";
  kit_image_digest: string;
  kit_sha256: string;
  /** The image's app source: /workspace/app without node_modules, src/proxy.ts and the empty build outputs. */
  source: { tree_sha256: string; files: Record<string, string> };
  /** The fixture package the image runs (/opt/rbw/verifier/kit/umami-fixture), as the added-suite hash counts it. */
  fixture: { tree_sha256: string; files: Record<string, string> };
  /** The frozen original-suite manifest. */
  original_suite: { sha256: string };
  /** The released incident (issue.json). */
  incident: { sha256: string };
  /** Other objects: each planted target file. */
  extra_objects: string[];
}

const SHA256 = /^[0-9a-f]{64}$/;

function safeSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === "..") return false;
  for (const char of segment) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || char === "\\") return false;
  }
  return true;
}

/** A relative POSIX path with no empty, "." or ".." segment, no backslash and no control character. */
export function isRelativePath(path: string): boolean {
  return path.split("/").every(safeSegment);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tree(value: unknown, what: string): { tree_sha256: string; files: Record<string, string> } {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "files,tree_sha256") throw new UmamiRefusal("store_invalid", `${what} is not a tree`);
  const { files, tree_sha256: sha } = value;
  if (typeof sha !== "string" || !SHA256.test(sha) || !isRecord(files)) throw new UmamiRefusal("store_invalid", `${what} is not a tree`);
  const checked: Record<string, string> = {};
  for (const [path, hash] of Object.entries(files)) {
    if (!isRelativePath(path) || typeof hash !== "string" || !SHA256.test(hash)) throw new UmamiRefusal("store_invalid", `${what} lists an unsafe path or a malformed hash`);
    checked[path] = hash;
  }
  if (treeSha256(checked) !== sha) throw new UmamiRefusal("store_invalid", `${what}'s tree_sha256 is not the hash of its files`);
  return { tree_sha256: sha, files: checked };
}

function single(value: unknown, what: string): { sha256: string } {
  if (!isRecord(value) || Object.keys(value).join(",") !== "sha256" || typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) {
    throw new UmamiRefusal("store_invalid", `${what} is not a file hash`);
  }
  return { sha256: value.sha256 };
}

const INDEX_KEYS = ["extra_objects", "fixture", "format", "host_id", "incident", "kit_image_digest", "kit_sha256", "original_suite", "source"].join(",");

/** Parses index bytes: canonical JSON with exactly the index's fields. */
export function parseIndex(bytes: Uint8Array): StoreIndex {
  let value: unknown;
  try {
    value = parseCanonical(bytes);
  } catch (error) {
    if (error instanceof CanonicalError) throw new UmamiRefusal("store_invalid", "index.json is not canonical JSON");
    throw error;
  }
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== INDEX_KEYS || value.format !== STORE_FORMAT || value.host_id !== "umami") {
    throw new UmamiRefusal("store_invalid", `index.json is not a ${STORE_FORMAT} index`);
  }
  const extra = value.extra_objects;
  if (!Array.isArray(extra) || !extra.every((item): item is string => typeof item === "string" && SHA256.test(item))) {
    throw new UmamiRefusal("store_invalid", "extra_objects is not a list of hashes");
  }
  if (typeof value.kit_image_digest !== "string" || typeof value.kit_sha256 !== "string") throw new UmamiRefusal("store_invalid", "the kit identity is missing");
  return {
    format: STORE_FORMAT,
    host_id: "umami",
    kit_image_digest: value.kit_image_digest,
    kit_sha256: value.kit_sha256,
    source: tree(value.source, "source"),
    fixture: tree(value.fixture, "fixture"),
    original_suite: single(value.original_suite, "original_suite"),
    incident: single(value.incident, "incident"),
    extra_objects: extra,
  };
}

/** Refuses an index that is not the pinned image's: kit identity, source tree, fixture, frozen suite and incident. */
export function checkIndex(index: StoreIndex, pins: UmamiPins): void {
  const mismatch = (what: string): UmamiRefusal => new UmamiRefusal("store_tree_mismatch", `the store's ${what} is not the pinned one`);
  if (index.kit_image_digest !== pins.kit.digest || index.kit_sha256 !== pins.kit.kit_sha256) throw mismatch("kit image");
  if (index.source.tree_sha256 !== pins.kit.source_tree_sha256 || Object.keys(index.source.files).length !== pins.kit.source_file_count) throw mismatch("source tree");
  if (index.fixture.tree_sha256 !== pins.kit.added_suite_sha256) throw mismatch("fixture");
  if (index.original_suite.sha256 !== pins.original_suite.sha256) throw mismatch("original suite");
  if (index.incident.sha256 !== pins.incident.sha256) throw mismatch("incident");
}

export interface PreparedStore {
  dir: string;
  index: StoreIndex;
  indexSha256: string;
  /** An object's bytes, checked against its hash. */
  read(sha256: string): Promise<Buffer>;
}

/** Opens a store and checks its index against the pins; reads nothing else yet. */
export async function openStore(dir: string, pins: UmamiPins): Promise<PreparedStore> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(dir, INDEX_FILE));
  } catch (error) {
    if (isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) throw new UmamiRefusal("store_missing", `no ${INDEX_FILE} in the store`);
    throw error;
  }
  const index = parseIndex(bytes);
  checkIndex(index, pins);
  return {
    dir,
    index,
    indexSha256: sha256Hex(bytes),
    async read(sha256) {
      if (!SHA256.test(sha256)) throw new UmamiRefusal("store_object_mismatch", "an object name is not a SHA-256");
      let content: Buffer;
      try {
        content = await readFile(join(dir, OBJECTS_DIR, sha256));
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") throw new UmamiRefusal("store_object_mismatch", `object ${sha256} is missing`);
        throw error;
      }
      if (sha256Hex(content) !== sha256) throw new UmamiRefusal("store_object_mismatch", `object ${sha256} does not hash to its name`);
      return content;
    },
  };
}

/** Writes each file of a tree from the store into `dir`, which must be new and empty. */
export async function materialize(store: PreparedStore, files: Tree, dir: string): Promise<void> {
  for (const [path, sha256] of Object.entries(files)) {
    if (!isRelativePath(path)) throw new UmamiRefusal("store_invalid", "a tree lists an unsafe path");
    const target = join(dir, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await store.read(sha256), { flag: "wx", mode: 0o644 });
  }
}

/** Writes a store: every object once by its hash, then the index. Used by the prepare step and by tests. */
export async function writeStore(dir: string, index: StoreIndex, objects: ReadonlyMap<string, Uint8Array>): Promise<string> {
  const needed = new Set([...Object.values(index.source.files), ...Object.values(index.fixture.files), index.original_suite.sha256, index.incident.sha256, ...index.extra_objects]);
  await mkdir(join(dir, OBJECTS_DIR), { recursive: true });
  for (const sha256 of needed) {
    const bytes = objects.get(sha256);
    if (bytes === undefined || sha256Hex(bytes) !== sha256) throw new UmamiRefusal("store_object_mismatch", `object ${sha256} is missing or has other bytes`);
    await writeFile(join(dir, OBJECTS_DIR, sha256), bytes, { flag: "wx" });
  }
  const bytes = encodeCanonical(index);
  await writeFile(join(dir, INDEX_FILE), bytes, { flag: "wx" });
  return sha256Hex(bytes);
}
