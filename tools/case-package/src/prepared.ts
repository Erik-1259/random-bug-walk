// The prepared directory: content-addressed archives `<sha256>.tar.gz` next to `index.json`, which maps
// each catalog entry to its bug case and validator core. The worker image and the public store are both
// filled from this one directory; readers check every object's hash.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeCanonical, parseCanonical, sha256Hex } from "@rbw/schema";
import type { PreparedCase } from "./export.ts";
import {
  comparePrepared,
  parsePreparedIndex,
  PREPARED_INDEX,
  PREPARED_INDEX_FORMAT,
  preparedObjectName,
  type PreparedEntry,
  type PreparedIndex,
} from "./format.ts";

const HASH = /^[0-9a-f]{64}$/;

async function writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.partial-${String(process.pid)}`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

async function existingIndex(dir: string): Promise<PreparedIndex | null> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(join(dir, PREPARED_INDEX)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parsePreparedIndex(parseCanonical(bytes));
}

/** Reads an object and checks that its bytes hash to its name. */
export async function readPreparedObject(dir: string, sha256: string): Promise<Uint8Array> {
  if (!HASH.test(sha256)) throw new Error("prepared object: not a SHA-256");
  const bytes = new Uint8Array(await readFile(join(dir, preparedObjectName(sha256))));
  if (sha256Hex(bytes) !== sha256) throw new Error("prepared object: bytes differ from the object's name");
  return bytes;
}

/** Writes an object unless the same bytes are already there; an object with other bytes is replaced. */
async function writeObject(dir: string, sha256: string, bytes: Uint8Array): Promise<void> {
  const path = join(dir, preparedObjectName(sha256));
  let existing: Uint8Array | null = null;
  try {
    existing = new Uint8Array(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== null && sha256Hex(existing) === sha256) return;
  await writeAtomically(path, bytes);
}

/**
 * Writes the cases' archives and merges their entries into the directory's index: an entry with the same
 * host and entry ID is replaced, other entries are kept. Returns the index as written.
 */
export async function writePrepared(dir: string, cases: readonly PreparedCase[]): Promise<PreparedIndex> {
  await mkdir(dir, { recursive: true });
  for (const item of cases) {
    await writeObject(dir, item.bug_case.sha256, item.bug_case.bytes);
    await writeObject(dir, item.validator_core.sha256, item.validator_core.bytes);
  }
  const entries = new Map<string, PreparedEntry>();
  const key = (entry: Pick<PreparedEntry, "host_id" | "entry_id">): string => `${entry.host_id}\n${entry.entry_id}`;
  for (const entry of (await existingIndex(dir))?.entries ?? []) entries.set(key(entry), entry);
  for (const item of cases) {
    entries.set(key(item), {
      host_id: item.host_id,
      entry_id: item.entry_id,
      catalog_version: item.catalog_version,
      package_version: item.package_version,
      case_id: item.case_id,
      defect_id: item.defect_id,
      bug_case_sha256: item.bug_case.sha256,
      bug_case_size_bytes: item.bug_case.size_bytes,
      validator_core_sha256: item.validator_core.sha256,
      validator_core_size_bytes: item.validator_core.size_bytes,
      scanned: item.scanned,
    });
  }
  const index: PreparedIndex = { format: PREPARED_INDEX_FORMAT, entries: [...entries.values()].sort(comparePrepared) };
  await writeAtomically(join(dir, PREPARED_INDEX), encodeCanonical(index));
  return index;
}

/** Reads and checks the directory's index. */
export async function readPreparedIndex(dir: string): Promise<PreparedIndex> {
  const index = await existingIndex(dir);
  if (index === null) throw new Error("prepared directory: no index.json");
  return index;
}
