import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogEntry, HostAdapter } from "@rbw/factory-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportCase, ExportRefused, type ScanHook } from "../src/export.ts";
import { readPreparedIndex, readPreparedObject, writePrepared } from "../src/prepared.ts";
import { buildSyntheticPair, SYNTHETIC_LICENSE, syntheticAdapter, syntheticIdentity } from "../src/synthetic.ts";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

let workdir: string;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "case-package-test-"));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function only(adapter: HostAdapter): CatalogEntry {
  const entry = adapter.catalog()[0];
  if (entry === undefined) throw new Error("empty synthetic catalog");
  return entry;
}

async function refusalOf(promise: Promise<unknown>): Promise<ExportRefused> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExportRefused) return error;
    throw error;
  }
  throw new Error("export was not refused");
}

const clean: ScanHook = () => Promise.resolve({ outcome: "clean" });

describe("exportCase", () => {
  it("exports the adapter's on-disk inputs to exactly the synthetic pair builder's bytes", async () => {
    const adapter = syntheticAdapter({ host_id: "umami", seeds: ["07"], workdir });
    const exported = await exportCase({ adapter, entry: only(adapter), identity: syntheticIdentity, license: SYNTHETIC_LICENSE, scan: clean });
    const built = buildSyntheticPair({ host_id: "umami", seed: "07", evidence: null });
    expect(exported.bug_case.sha256).toBe(built.bug_case.sha256);
    expect(exported.validator_core.sha256).toBe(built.validator_core.sha256);
    expect(exported.case_id).toBe(built.case_id);
    expect(exported.defect_id).toBe(built.defect_id);
    expect(exported.scanned).toBe(true);
  });

  it("gives the same bytes on a second export into a fresh directory", async () => {
    const first = syntheticAdapter({ seeds: ["01"], workdir: join(workdir, "a") });
    const second = syntheticAdapter({ seeds: ["01"], workdir: join(workdir, "b") });
    const a = await exportCase({ adapter: first, entry: only(first), identity: syntheticIdentity, license: SYNTHETIC_LICENSE, scan: null });
    const b = await exportCase({ adapter: second, entry: only(second), identity: syntheticIdentity, license: SYNTHETIC_LICENSE, scan: null });
    expect(Buffer.from(b.bug_case.bytes).equals(Buffer.from(a.bug_case.bytes))).toBe(true);
    expect(Buffer.from(b.validator_core.bytes).equals(Buffer.from(a.validator_core.bytes))).toBe(true);
    expect(a.scanned).toBe(false);
  });

  it("refuses a listed file whose bytes on disk differ from its listed hash", async () => {
    const adapter = syntheticAdapter({ seeds: ["01"], workdir });
    const tampering: HostAdapter = {
      ...adapter,
      bugCaseInputs: async (entry) => {
        const inputs = await adapter.bugCaseInputs(entry);
        const file = inputs.source.files[0];
        if (file === undefined) throw new Error("no source file");
        await writeFile(join(inputs.source.root, file.path), "tampered\n");
        return inputs;
      },
    };
    const error = await refusalOf(exportCase({ adapter: tampering, entry: only(adapter), identity: syntheticIdentity, license: SYNTHETIC_LICENSE, scan: null }));
    expect(error.code).toBe("unreadable_input");
  });

  it("refuses a listed file that is a symbolic link", async () => {
    const adapter = syntheticAdapter({ seeds: ["01"], workdir });
    const linking: HostAdapter = {
      ...adapter,
      bugCaseInputs: async (entry) => {
        const inputs = await adapter.bugCaseInputs(entry);
        const file = inputs.incident.files[0];
        if (file === undefined) throw new Error("no incident file");
        const path = join(inputs.incident.root, file.path);
        const target = join(workdir, "outside.md");
        await writeFile(target, await readFile(path));
        await rm(path);
        await symlink(target, path);
        return inputs;
      },
    };
    const error = await refusalOf(exportCase({ adapter: linking, entry: only(adapter), identity: syntheticIdentity, license: SYNTHETIC_LICENSE, scan: null }));
    expect(error.code).toBe("unreadable_input");
  });

  it("refuses a reference repair whose application to the exported buggy source does not give its result hashes", async () => {
    const adapter = syntheticAdapter({ seeds: ["01"], workdir });
    const entry = only(adapter);
    const wrong = {
      ...entry,
      reference_repair: { ...entry.reference_repair, result_sha256: entry.reference_repair.result_sha256.map((item) => ({ ...item, sha256: "0".repeat(64) })) },
    };
    const lying: HostAdapter = {
      ...adapter,
      catalog: () => [wrong],
      validatorInputs: async () => ({ ...(await adapter.validatorInputs(entry)), reference_repair: wrong.reference_repair }),
    };
    const error = await refusalOf(exportCase({ adapter: lying, entry: wrong, identity: syntheticIdentity, license: SYNTHETIC_LICENSE, scan: null }));
    expect(error.code).toBe("repair_mismatch");
  });

  it("refuses a clean reconstruction that does not give the planted targets' original hashes", async () => {
    const adapter = syntheticAdapter({ seeds: ["01"], workdir });
    const entry = only(adapter);
    const target = entry.plant.targets[0];
    if (target === undefined) throw new Error("no target");
    const wrong = { ...entry, plant: { ...entry.plant, targets: [{ ...target, before_sha256: "0".repeat(64) }] } };
    const error = await refusalOf(exportCase({ adapter: { ...adapter, catalog: () => [wrong] }, entry: wrong, identity: syntheticIdentity, license: SYNTHETIC_LICENSE, scan: null }));
    expect(error.code).toBe("repair_mismatch");
  });

  it("refuses inputs for another host or entry", async () => {
    const adapter = syntheticAdapter({ seeds: ["01"], workdir });
    const entry = only(adapter);
    const other: HostAdapter = { ...adapter, bugCaseInputs: async () => ({ ...(await adapter.bugCaseInputs(entry)), entry_id: "synthetic-other" }) };
    const error = await refusalOf(exportCase({ adapter: other, entry, identity: syntheticIdentity, license: SYNTHETIC_LICENSE, scan: null }));
    expect(error.code).toBe("inconsistent_inputs");
  });

  it("refuses incident files that do not hold the entry's incident description", async () => {
    const adapter = syntheticAdapter({ seeds: ["01"], workdir });
    const entry = only(adapter);
    const otherBytes: HostAdapter = {
      ...adapter,
      bugCaseInputs: async (item) => {
        const inputs = await adapter.bugCaseInputs(item);
        const path = join(inputs.incident.root, entry.incident.path);
        await writeFile(path, "a different synthetic incident\n");
        return { ...inputs, incident: { ...inputs.incident, files: [{ path: entry.incident.path, sha256: sha(await readFile(path)) }] } };
      },
    };
    const changed = await refusalOf(exportCase({ adapter: otherBytes, entry, identity: syntheticIdentity, license: SYNTHETIC_LICENSE, scan: null }));
    expect(changed.code).toBe("inconsistent_inputs");

    const otherPath: HostAdapter = {
      ...adapter,
      bugCaseInputs: async (item) => {
        const inputs = await adapter.bugCaseInputs(item);
        const bytes = await readFile(join(inputs.incident.root, entry.incident.path));
        await writeFile(join(inputs.incident.root, "synthetic-other-incident.md"), bytes);
        return { ...inputs, incident: { ...inputs.incident, files: [{ path: "synthetic-other-incident.md", sha256: sha(bytes) }] } };
      },
    };
    const moved = await refusalOf(exportCase({ adapter: otherPath, entry, identity: syntheticIdentity, license: SYNTHETIC_LICENSE, scan: null }));
    expect(moved.code).toBe("inconsistent_inputs");
  });

  it("refuses a validator protocol that differs from the protocol the adapter declares for the entry", async () => {
    const adapter = syntheticAdapter({ seeds: ["01"], workdir });
    const entry = only(adapter);
    const declared = adapter.protocol(entry);
    // Admission prices the run from adapter.protocol(entry); the archive must hold that same protocol.
    const differing: HostAdapter = {
      ...adapter,
      protocol: () => ({ ...declared, per_state: { ...declared.per_state, buggy: { ...declared.per_state.buggy, copies: declared.per_state.buggy.copies + 1 } } }),
    };
    const error = await refusalOf(exportCase({ adapter: differing, entry, identity: syntheticIdentity, license: SYNTHETIC_LICENSE, scan: null }));
    expect(error.code).toBe("inconsistent_inputs");
  });

  it("hands every member of both parts to the scan hook before anything is returned, and refuses a blocked or unavailable scan", async () => {
    const adapter = syntheticAdapter({ seeds: ["01"], workdir });
    const seen: { part: string; paths: string[] }[] = [];
    const recording: ScanHook = (input) => {
      seen.push({ part: input.part, paths: input.members.map((member) => member.path) });
      return Promise.resolve({ outcome: "clean" });
    };
    await exportCase({ adapter, entry: only(adapter), identity: syntheticIdentity, license: SYNTHETIC_LICENSE, scan: recording });
    expect(seen.map((item) => item.part)).toEqual(["bug_case", "validator"]);
    expect(seen[0]?.paths).toContain("bug-case.json");
    expect(seen[1]?.paths).toContain("validator.json");
    expect(seen[1]?.paths).toContain("repair/reference.patch");

    const blocked = await refusalOf(exportCase({
      adapter, entry: only(adapter), identity: syntheticIdentity, license: SYNTHETIC_LICENSE,
      scan: () => Promise.resolve({ outcome: "blocked", locations: ["source/x:1"] }),
    }));
    expect(blocked.code).toBe("scan_blocked");
    expect(blocked.problems).toEqual(["bug_case: source/x:1"]);
    const unnamed = await refusalOf(exportCase({
      adapter, entry: only(adapter), identity: syntheticIdentity, license: SYNTHETIC_LICENSE,
      scan: () => Promise.resolve({ outcome: "blocked", locations: [] }),
    }));
    expect(unnamed.problems).toEqual(["bug_case: blocked"]);
    const unavailable = await refusalOf(exportCase({
      adapter, entry: only(adapter), identity: syntheticIdentity, license: SYNTHETIC_LICENSE,
      scan: () => Promise.resolve({ outcome: "unavailable" }),
    }));
    expect(unavailable.code).toBe("scan_unavailable");
  });

  it("fails closed on any scan answer other than clean", async () => {
    const adapter = syntheticAdapter({ seeds: ["01"], workdir });
    // The scanner's detailed result wraps the verdict; passed through unwrapped by mistake, it must not count as clean.
    for (const answer of [{ result: { outcome: "blocked", locations: [] } }, { outcome: "error" }, null, undefined, "clean"]) {
      const error = await refusalOf(exportCase({
        adapter, entry: only(adapter), identity: syntheticIdentity, license: SYNTHETIC_LICENSE,
        scan: (() => Promise.resolve(answer)) as unknown as ScanHook,
      }));
      expect(error.code, JSON.stringify(answer)).toBe("scan_unavailable");
    }
  });
});

describe("prepared directory", () => {
  it("writes content-addressed objects and an index, and reads them back hash-checked", async () => {
    const adapter = syntheticAdapter({ seeds: ["01", "02"], workdir: join(workdir, "inputs") });
    const cases = [];
    for (const entry of adapter.catalog()) {
      cases.push(await exportCase({ adapter, entry, identity: syntheticIdentity, license: SYNTHETIC_LICENSE, scan: clean }));
    }
    const out = join(workdir, "prepared");
    const index = await writePrepared(out, cases);
    expect(index.entries.map((entry) => entry.entry_id)).toEqual(cases.map((item) => item.entry_id).sort());
    const names = (await readdir(out)).sort();
    const objects = cases.flatMap((item) => [`${item.bug_case.sha256}.tar.gz`, `${item.validator_core.sha256}.tar.gz`]);
    expect(names).toEqual([...objects, "index.json"].sort());
    expect(await readPreparedIndex(out)).toEqual(index);
    const first = cases[0];
    if (first === undefined) throw new Error("no case");
    expect(sha(await readPreparedObject(out, first.bug_case.sha256))).toBe(first.bug_case.sha256);

    // A second write of the same cases changes nothing; a tampered object is refused on read.
    const again = await writePrepared(out, cases);
    expect(again).toEqual(index);
    await writeFile(join(out, `${first.bug_case.sha256}.tar.gz`), "tampered");
    await expect(readPreparedObject(out, first.bug_case.sha256)).rejects.toThrow();
  });

  it("keeps earlier index entries of other entries when a later run adds more", async () => {
    const adapter = syntheticAdapter({ seeds: ["01", "02"], workdir: join(workdir, "inputs") });
    const [one, two] = adapter.catalog();
    if (one === undefined || two === undefined) throw new Error("expected two entries");
    const out = join(workdir, "prepared");
    await writePrepared(out, [await exportCase({ adapter, entry: one, identity: syntheticIdentity, license: SYNTHETIC_LICENSE, scan: null })]);
    const index = await writePrepared(out, [await exportCase({ adapter, entry: two, identity: syntheticIdentity, license: SYNTHETIC_LICENSE, scan: null })]);
    expect(index.entries.map((entry) => entry.entry_id)).toEqual([one.entry_id, two.entry_id].sort());
    expect(index.entries.every((entry) => !entry.scanned)).toBe(true);
  });
});
