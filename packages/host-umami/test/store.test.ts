// The prepared store's integrity refusals, one guard per test: a synthetic store whose index.json
// is changed by hand after it was written, read through the adapter (and, where a later check would
// hide a guard, through the store functions themselves).
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeCanonical, sha256Hex } from "@rbw/schema";
import { afterEach, describe, expect, it } from "vitest";
import { buildUmamiAdapter } from "../src/adapter.ts";
import { buildCatalogEntry } from "../src/catalog.ts";
import { UmamiRefusal } from "../src/errors.ts";
import { validatorInputs } from "../src/inputs.ts";
import type { UmamiPins } from "../src/pins.ts";
import { INDEX_FILE, OBJECTS_DIR, materialize, openStore, parseIndex } from "../src/store.ts";
import type { StoreIndex } from "../src/store.ts";
import { treeSha256 } from "../src/tree.ts";
import { cleanupTemp, recordingNewDir, syntheticWorld, tempDir, writeSyntheticStore } from "./support.ts";
import type { SyntheticWorld } from "./support.ts";

afterEach(cleanupTemp);

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof UmamiRefusal) return error.code;
    throw error;
  }
  return "no refusal";
}

function syncRefusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof UmamiRefusal) return error.code;
    throw error;
  }
  return "no refusal";
}

/** A store written from the world, then its index.json replaced by `index`; `extra` adds objects. */
async function storeWithIndex(world: SyntheticWorld, index: unknown, extra: readonly Uint8Array[] = []): Promise<string> {
  const dir = await writeSyntheticStore(world);
  for (const bytes of extra) writeFileSync(join(dir, OBJECTS_DIR, sha256Hex(bytes)), bytes);
  writeFileSync(join(dir, INDEX_FILE), encodeCanonical(index));
  return dir;
}

/** What each of the adapter's two store readers reports for a store under the pins. */
async function bothRefusals(pins: UmamiPins, store: string): Promise<[string, string]> {
  const out = recordingNewDir();
  const adapter = buildUmamiAdapter(pins, { store, newDir: out.newDir });
  const [entry] = adapter.catalog();
  if (entry === undefined) throw new Error("the catalog is empty");
  return [await refusal(() => adapter.bugCaseInputs(entry)), await refusal(() => adapter.validatorInputs(entry))];
}

const clone = (index: StoreIndex): StoreIndex => structuredClone(index);

describe("the prepared store's index", () => {
  it("reads a store that was written as it is", async () => {
    const world = syntheticWorld();
    expect(await bothRefusals(world.pins, await writeSyntheticStore(world))).toEqual(["no refusal", "no refusal"]);
  });

  it("refuses a tree whose tree_sha256 is the pinned one but whose files differ (store_invalid)", async () => {
    const world = syntheticWorld();
    const otherObject = world.pins.target.after_sha256;
    const source = clone(world.index);
    source.source.files = { ...source.source.files, "README.md": otherObject };
    expect(source.source.tree_sha256).toBe(world.pins.kit.source_tree_sha256);
    expect(await bothRefusals(world.pins, await storeWithIndex(world, source))).toEqual(["store_invalid", "store_invalid"]);
    const fixture = clone(world.index);
    fixture.fixture.files = { ...fixture.fixture.files, "package.json": otherObject };
    expect(fixture.fixture.tree_sha256).toBe(world.pins.kit.added_suite_sha256);
    expect(await bothRefusals(world.pins, await storeWithIndex(world, fixture))).toEqual(["store_invalid", "store_invalid"]);
  });

  it.each([
    ["a parent segment", "../escape.txt"],
    ["an absolute path", "/escape.txt"],
    ["an empty segment", "src//escape.txt"],
    ["a backslash", "src\\escape.txt"],
  ])("refuses a source path with %s, even when the pins name that tree (store_invalid)", async (_what, path) => {
    const world = syntheticWorld();
    const index = clone(world.index);
    index.source.files = { ...index.source.files, [path]: world.pins.target.after_sha256 };
    index.source.tree_sha256 = treeSha256(index.source.files);
    const pins: UmamiPins = {
      ...world.pins,
      kit: { ...world.pins.kit, source_tree_sha256: index.source.tree_sha256, source_file_count: Object.keys(index.source.files).length },
    };
    const store = await storeWithIndex(world, index);
    expect(await bothRefusals(pins, store)).toEqual(["store_invalid", "store_invalid"]);
    // parseIndex refuses it on its own, before anything is materialized.
    expect(syncRefusal(() => parseIndex(encodeCanonical(index)))).toBe("store_invalid");
  });

  it("refuses a file hash that is not a SHA-256 (store_invalid)", () => {
    const world = syntheticWorld();
    const index = clone(world.index);
    index.source.files = { ...index.source.files, "README.md": "not-a-hash" };
    index.source.tree_sha256 = treeSha256(index.source.files);
    expect(syncRefusal(() => parseIndex(encodeCanonical(index)))).toBe("store_invalid");
  });

  it.each([
    ["an extra key", (index: Record<string, unknown>) => ({ ...index, synthetic_extra: "x" })],
    ["a missing key", (index: Record<string, unknown>) => Object.fromEntries(Object.entries(index).filter(([key]) => key !== "incident"))],
    ["another format", (index: Record<string, unknown>) => ({ ...index, format: "rbw-host-umami-store/2" })],
    ["another host", (index: Record<string, unknown>) => ({ ...index, host_id: "synthetic-host" })],
    ["extra objects that are not hashes", (index: Record<string, unknown>) => ({ ...index, extra_objects: ["not-a-hash"] })],
    ["a kit identity that is not text", (index: Record<string, unknown>) => ({ ...index, kit_sha256: 7 })],
  ])("refuses an index with %s (store_invalid)", async (_what, edit) => {
    const world = syntheticWorld();
    const index = edit({ ...clone(world.index) });
    expect(await bothRefusals(world.pins, await storeWithIndex(world, index))).toEqual(["store_invalid", "store_invalid"]);
  });

  it.each([
    ["kit image digest", (index: StoreIndex) => ({ ...index, kit_image_digest: `sha256:${"c".repeat(64)}` })],
    ["kit manifest hash", (index: StoreIndex) => ({ ...index, kit_sha256: "d".repeat(64) })],
  ])("refuses another %s (store_tree_mismatch)", async (_what, edit) => {
    const world = syntheticWorld();
    expect(await bothRefusals(world.pins, await storeWithIndex(world, edit(clone(world.index))))).toEqual(["store_tree_mismatch", "store_tree_mismatch"]);
  });

  it("refuses a fixture tree that is not the pinned image's (store_tree_mismatch)", async () => {
    const world = syntheticWorld();
    const index = clone(world.index);
    index.fixture.files = Object.fromEntries(Object.entries(index.fixture.files).filter(([path]) => path !== "package.json"));
    index.fixture.tree_sha256 = treeSha256(index.fixture.files);
    expect(await bothRefusals(world.pins, await storeWithIndex(world, index))).toEqual(["store_tree_mismatch", "store_tree_mismatch"]);
  });

  it("refuses another frozen original suite, even one with the pinned test IDs (store_tree_mismatch)", async () => {
    const world = syntheticWorld();
    const sameIds = Buffer.from(world.suiteBytes.toString("utf8").replace('"synthetic":true', '"synthetic":"other copy"'), "utf8");
    expect(sameIds.equals(world.suiteBytes)).toBe(false);
    const index = clone(world.index);
    index.original_suite = { sha256: sha256Hex(sameIds) };
    expect(await bothRefusals(world.pins, await storeWithIndex(world, index, [sameIds]))).toEqual(["store_tree_mismatch", "store_tree_mismatch"]);
  });

  it("refuses another incident (store_tree_mismatch)", async () => {
    const world = syntheticWorld();
    const other = Buffer.from('{"title":"Synthetic other incident"}\n', "utf8");
    const index = clone(world.index);
    index.incident = { sha256: sha256Hex(other) };
    expect(await bothRefusals(world.pins, await storeWithIndex(world, index, [other]))).toEqual(["store_tree_mismatch", "store_tree_mismatch"]);
  });
});

describe("materialize", () => {
  it("refuses an unsafe path and writes nothing outside its directory", async () => {
    const world = syntheticWorld();
    const store = await openStore(await writeSyntheticStore(world), world.pins);
    const parent = tempDir("rbw-host-umami-out-");
    const dir = join(parent, "inner");
    expect(await refusal(() => materialize(store, { "../escape.txt": world.pins.target.after_sha256 }, dir))).toBe("store_invalid");
    expect(existsSync(join(parent, "escape.txt"))).toBe(false);
  });
});

describe("validatorInputs", () => {
  it("refuses a fixture that is not the entry's check set (checks_not_kit)", async () => {
    const world = syntheticWorld();
    const store = await writeSyntheticStore(world);
    const entry = buildCatalogEntry(world.pins);
    const other = { ...entry, verification: { ...entry.verification, check_set_sha256: "e".repeat(64) } };
    expect(await refusal(() => validatorInputs(world.pins, other, { store, newDir: recordingNewDir().newDir }))).toBe("checks_not_kit");
  });

  it("refuses when the job it builds is not the pinned frozen job (evaluator_mismatch)", async () => {
    const world = syntheticWorld();
    const store = await writeSyntheticStore(world);
    for (const job of [
      { ...world.pins.job, request_sha256: "f".repeat(64) },
      { ...world.pins.job, expected_trials_sha256: "f".repeat(64) },
    ]) {
      const pins: UmamiPins = { ...world.pins, job };
      const adapter = buildUmamiAdapter(pins, { store, newDir: recordingNewDir().newDir });
      const [entry] = adapter.catalog();
      if (entry === undefined) throw new Error("the catalog is empty");
      expect(await refusal(() => adapter.validatorInputs(entry))).toBe("evaluator_mismatch");
    }
  });
});
