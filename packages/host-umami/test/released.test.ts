// Regression pins for the released Umami case: its ID, its record's SHA-256 and its files' hashes
// as literal values (read once from releases/319f3100-9ecf-441d-b7af-a643af9ae4e5/release.json in
// the results repository), and a check that the adapter writes to none of the released inputs.
import { afterEach, describe, expect, it } from "vitest";
import type { CopyState } from "@rbw/factory-contract";
import { buildUmamiAdapter, createUmamiAdapter } from "../src/adapter.ts";
import { RELEASED_CASE, releasedCaseMapping } from "../src/mapping.ts";
import { UMAMI_PINS } from "../src/pins.ts";
import { UMAMI_PROTOCOL } from "../src/protocol.ts";
import { readCopyResults } from "../src/records.ts";
import { cleanupTemp, copyDraft, evaluatorTree, hashTree, recordingNewDir, repoPath, syntheticWorld, unpackedPair, writeCopyResults, writeSyntheticStore } from "./support.ts";

afterEach(cleanupTemp);

describe("the released case's pins", () => {
  it("are the release record's ID, SHA-256 and file hashes", () => {
    expect(RELEASED_CASE.release_id).toBe("319f3100-9ecf-441d-b7af-a643af9ae4e5");
    expect(RELEASED_CASE.release_sha256).toBe("838c51516c9dc2a75490ae81839792a99b6d388fc46f1a23a2d2bc0fa312c8b7");
    expect(RELEASED_CASE.files).toEqual([
      { path: "issue-check.json", sha256: "e05637e56f4be2f5cf88a483450e3b1a90e90ededcbafeb4a53548959de8e839" },
      { path: "issue.json", sha256: "1a1d227377b5de18db1be03ddbb8aaf6d77ae7a5746cde37081922c3afc993c5" },
      { path: "recordings/card-1.recording.json", sha256: "2493b2ff5a349dfe79279af4c884c86d37136c18e790141c7051490b2f1a0976" },
      { path: "recordings/issue-2.recording.json", sha256: "3a8993432d14746b31b268242d60f6bae3b0d8e92a0d551b0dcc9d131d96ef11" },
    ]);
    expect(RELEASED_CASE.mutation_id).toBe("4c2531a343d8250607df3ab84491e2d7e655849c1dbcb477264a5c126b21ccca");
    expect(RELEASED_CASE.task_revision).toBe("2db3f06590c33b6f165b9b39f8afea4dad6198de07606f136aef4b255c9b8f02");
  });

  it("make the released issue.json the entry's incident, unchanged", () => {
    const [entry] = createUmamiAdapter().catalog();
    const issue = RELEASED_CASE.files.find((file) => file.path === "issue.json");
    expect(entry?.incident).toEqual({ path: "issue.json", sha256: issue?.sha256 });
    expect(UMAMI_PINS.incident.sha256).toBe(issue?.sha256);
  });
});

/** The repository files the released case, its judge job and its replays depend on. */
const RELEASED_INPUTS = [
  ["packages", "umami-fixture"],
  ["packages", "umami-driver", "src"],
  ["packages", "shapes", "probes", "dt-1.tz-arg"],
  ["tools", "local-runner", "probes"],
  ["kit", "umami"],
];

function snapshot(): Record<string, Record<string, string>> {
  const found: Record<string, Record<string, string>> = {};
  for (const parts of RELEASED_INPUTS) found[parts.join("/")] = hashTree(repoPath(...parts), (path) => path.split("/").includes("node_modules"));
  return found;
}

describe("the released inputs", () => {
  it("are never written: every adapter operation leaves them byte for byte as they were", async () => {
    const before = snapshot();
    const real = createUmamiAdapter();
    const [realEntry] = real.catalog();
    if (realEntry === undefined) throw new Error("the catalog is empty");
    real.baseline();
    real.protocol(realEntry);
    real.availability(realEntry, "2026-10-19T00:00:00.000Z", "2026-10-19T01:00:00.000Z");
    releasedCaseMapping(UMAMI_PINS, realEntry, { defectId: () => "0".repeat(64), caseId: () => "1".repeat(64) }, "1");

    const world = syntheticWorld();
    const store = await writeSyntheticStore(world);
    const storeBefore = hashTree(store);
    const out = recordingNewDir();
    const adapter = buildUmamiAdapter(world.pins, { store, newDir: out.newDir });
    const [entry] = adapter.catalog();
    if (entry === undefined) throw new Error("the catalog is empty");
    await adapter.bugCaseInputs(entry);
    await adapter.validatorInputs(entry);
    const pair = unpackedPair(world, evaluatorTree(world));
    for (const state of ["clean", "buggy", "fixed"] as CopyState[]) {
      adapter.copyPlans(state, pair, UMAMI_PROTOCOL);
      readCopyResults(world.pins, { state, outcome: "ran", resultsDir: writeCopyResults(world.job, copyDraft(world.job, state)) });
    }
    expect(snapshot()).toEqual(before);
    expect(hashTree(store)).toEqual(storeBefore);
    expect(out.dirs).toHaveLength(3);
  });
});
