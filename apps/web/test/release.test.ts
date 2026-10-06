import { cpSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest, encodeCanonical, parseCanonical, type JsonValue } from "@rbw/schema";
import { readPublishedFile, readResults, ReleaseError, type ReleaseErrorCode } from "../src/release.ts";
import {
  addRunFile,
  cleanup,
  copyFixture,
  DEVELOPMENT,
  DEVELOPMENT_ROOT,
  NO_RELEASE,
  readManifest,
  runDir,
  SYMPTOM_SOURCE,
  syntheticCase,
  writeFile,
  writeManifest,
} from "./support/results.ts";

afterEach(cleanup);

async function refusal(dir: string): Promise<ReleaseErrorCode> {
  try {
    await readResults(dir);
  } catch (error) {
    if (error instanceof ReleaseError) return error.code;
    throw error;
  }
  throw new Error("the release was accepted");
}

describe("development fixture (local run of 2026-10-06)", () => {
  it("reads the one published run with its symptom and no admission records", async () => {
    const results = await readResults(DEVELOPMENT);
    expect(results.release).toBeNull();
    expect(results.runs).toHaveLength(1);
    const [run] = results.runs;
    expect(run?.rootExecutionId).toBe(DEVELOPMENT_ROOT);
    expect(run).toMatchObject({ kind: "factory", status: "terminal", outcome: "completed", publicationStatus: "published", declaredStageCount: 1, childExecutionCount: 1 });
    expect(run?.manifest?.entries).toHaveLength(6);
    expect(run?.admission).toBeNull();
    expect(results.caseRun).toBe(run);
    expect(run?.symptom?.timezone).toBe("America/Los_Angeles");
    expect(run?.symptom?.expected.map((bucket) => bucket.count)).toEqual([3, 8, 1]);
    expect(run?.symptom?.observed.map((bucket) => bucket.count)).toEqual([2, 8, 2]);
  });

  it("holds the symptom of the committed writer input, byte for byte in canonical form", () => {
    const source = JSON.parse(readFileSync(SYMPTOM_SOURCE, "utf8")) as { issue: { symptom: JsonValue } };
    const published = readFileSync(join(runDir(DEVELOPMENT, DEVELOPMENT_ROOT), "generated", "symptom.json"));
    expect(published.equals(Buffer.from(canonicalDigest(source.issue.symptom).bytes))).toBe(true);
  });

  it("holds the planted copy's four recorded responses unchanged", () => {
    const observed = join(SYMPTOM_SOURCE, "..", "observed");
    for (const zone of ["utc", "la", "auckland", "kolkata"]) {
      const name = `tzarg.${zone}-day-counts.json`;
      const published = readFileSync(join(runDir(DEVELOPMENT, DEVELOPMENT_ROOT), "results", "00000000-0000-4000-8000-000000001007", "planted-01", name));
      expect(published.equals(readFileSync(join(observed, name)))).toBe(true);
    }
  });
});

describe("no-release fixture", () => {
  it("lists every run with its real status, including failed, incomplete and running runs", async () => {
    const results = await readResults(NO_RELEASE);
    expect(results.caseRun).toBeNull();
    expect(results.release).toBeNull();
    expect(results.runs.map((run) => [run.rootExecutionId, run.kind, run.status, run.outcome, run.publicationStatus, run.manifest === null])).toEqual([
      ["00000000-0000-4000-8000-000000002001", "factory", "terminal", "failed", "published", false],
      ["00000000-0000-4000-8000-000000002003", "factory", "terminal", "incomplete", "published", false],
      ["00000000-0000-4000-8000-000000002005", "kit_check", "running", null, null, true],
    ]);
    const incomplete = results.runs[1]?.manifest?.entries.find((entry) => entry.outcome === "not_produced");
    expect(incomplete).toMatchObject({ trial_id: "clean-01", reason: "stage_failed", sha256: null });
  });
});

describe("synthetic case with admission records", () => {
  it("reads the admission evidence and decision of the case run", async () => {
    const built = syntheticCase();
    const results = await readResults(built.dir);
    const admission = results.caseRun?.admission;
    expect(admission?.executionId).toBe(built.execution);
    expect(admission?.decision.outcome_verdict).toBe("pass");
    expect(admission?.decision.comparison?.classification).toBe("blind_spot_demonstrated");
    expect(admission?.evidence.cells).toHaveLength(6);
  });
});

describe("published files", () => {
  it("returns a listed file's bytes and media type", async () => {
    const file = await readPublishedFile(DEVELOPMENT, DEVELOPMENT_ROOT, "report.md");
    expect(file?.mediaType).toBe("text/markdown");
    expect(Buffer.from(file?.bytes ?? []).toString("utf8")).toContain("Development evidence");
  });

  it("returns the manifest itself", async () => {
    const file = await readPublishedFile(DEVELOPMENT, DEVELOPMENT_ROOT, "manifest.json");
    expect(file?.mediaType).toBe("application/json");
    expect(parseCanonical(file?.bytes ?? new Uint8Array())).toMatchObject({ root_execution_id: DEVELOPMENT_ROOT });
  });

  it("returns nothing for an unlisted path, an unknown run or a traversal", async () => {
    expect(await readPublishedFile(DEVELOPMENT, DEVELOPMENT_ROOT, "missing.json")).toBeNull();
    expect(await readPublishedFile(DEVELOPMENT, "00000000-0000-4000-8000-000000009999", "report.md")).toBeNull();
    expect(await readPublishedFile(DEVELOPMENT, DEVELOPMENT_ROOT, "../../../package.json")).toBeNull();
  });

  it("returns nothing for an entry that was not produced", async () => {
    expect(await readPublishedFile(NO_RELEASE, "00000000-0000-4000-8000-000000002003", "results/00000000-0000-4000-8000-000000002004/clean-01/trial-result.json")).toBeNull();
  });
});

describe("malformed releases are refused", () => {
  it("a directory without a repository", async () => {
    const dir = copyFixture(DEVELOPMENT);
    rmSync(join(dir, "repository"), { recursive: true });
    expect(await refusal(dir)).toBe("layout");
  });

  it("a manifest that is not canonical bytes", async () => {
    const dir = copyFixture(DEVELOPMENT);
    const path = join(runDir(dir, DEVELOPMENT_ROOT), "manifest.json");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
    expect(await refusal(dir)).toBe("manifest_invalid");
  });

  it("a manifest that fails the schema", async () => {
    const dir = copyFixture(DEVELOPMENT);
    const path = join(runDir(dir, DEVELOPMENT_ROOT), "manifest.json");
    const value = parseCanonical(readFileSync(path)) as Record<string, unknown>;
    writeFileSync(path, encodeCanonical({ ...value, outcome: "succeeded" }));
    expect(await refusal(dir)).toBe("manifest_invalid");
  });

  it("a run directory that does not match the manifest's root", async () => {
    const dir = copyFixture(DEVELOPMENT);
    renameSync(runDir(dir, DEVELOPMENT_ROOT), runDir(dir, "00000000-0000-4000-8000-000000009999"));
    expect(await refusal(dir)).toBe("run_directory_mismatch");
  });

  it("a published file whose bytes differ from the manifest", async () => {
    const dir = copyFixture(DEVELOPMENT);
    writeFileSync(join(runDir(dir, DEVELOPMENT_ROOT), "report.md"), "# changed\n");
    expect(await refusal(dir)).toBe("file_hash_mismatch");
  });

  it("a listed file that is missing", async () => {
    const dir = copyFixture(DEVELOPMENT);
    rmSync(join(runDir(dir, DEVELOPMENT_ROOT), "report.md"));
    expect(await refusal(dir)).toBe("file_missing");
  });

  it("a file the manifest does not list", async () => {
    const dir = copyFixture(DEVELOPMENT);
    writeFile(join(runDir(dir, DEVELOPMENT_ROOT), "logs", "extra.log"), "unlisted\n");
    expect(await refusal(dir)).toBe("file_unlisted");
  });

  it("a status object that disagrees with the published manifest", async () => {
    const dir = copyFixture(DEVELOPMENT);
    const path = join(dir, "store", "status", `${DEVELOPMENT_ROOT}.json`);
    const value = parseCanonical(readFileSync(path)) as Record<string, unknown>;
    writeFileSync(path, encodeCanonical({ ...value, outcome: "failed" }));
    expect(await refusal(dir)).toBe("status_mismatch");
  });

  it("a status object that says published for a run the repository does not hold", async () => {
    const dir = copyFixture(DEVELOPMENT);
    rmSync(runDir(dir, DEVELOPMENT_ROOT), { recursive: true });
    expect(await refusal(dir)).toBe("run_missing");
  });

  it("a status object whose name is not its root", async () => {
    const dir = copyFixture(NO_RELEASE);
    renameSync(join(dir, "store", "status", "00000000-0000-4000-8000-000000002005.json"), join(dir, "store", "status", "00000000-0000-4000-8000-000000002006.json"));
    expect(await refusal(dir)).toBe("status_invalid");
  });

  it("a symptom that is not an ObservedSymptom", async () => {
    const dir = copyFixture(DEVELOPMENT);
    addRunFile(dir, DEVELOPMENT_ROOT, "generated/symptom.json", DEVELOPMENT_ROOT, encodeCanonical({ schema_version: 1 }));
    expect(await refusal(dir)).toBe("symptom_invalid");
  });

  it("an evidence file that fails the evidence shape", async () => {
    const built = syntheticCase();
    addRunFile(built.dir, built.root, `results/${built.execution}/evidence.json`, built.execution, encodeCanonical({ schema_version: 1 }));
    expect(await refusal(built.dir)).toBe("admission_invalid");
  });

  it("a decision whose evidence hash is not the evidence file's", async () => {
    const built = syntheticCase();
    const path = `results/${built.execution}/decision.json`;
    const decision = parseCanonical(readFileSync(join(runDir(built.dir, built.root), path))) as Record<string, unknown>;
    addRunFile(built.dir, built.root, path, built.execution, encodeCanonical({ ...decision, evidence_sha256: "0".repeat(64) }));
    expect(await refusal(built.dir)).toBe("admission_mismatch");
  });

  it("evidence of another root", async () => {
    const built = syntheticCase();
    const evidence = { ...built.evidence, request: { ...built.evidence.request, root_execution_id: "00000000-0000-4000-8000-000000009999" } };
    const evidencePath = `results/${built.execution}/evidence.json`;
    addRunFile(built.dir, built.root, evidencePath, built.execution, canonicalDigest(evidence).bytes);
    const decisionPath = `results/${built.execution}/decision.json`;
    const decision = parseCanonical(readFileSync(join(runDir(built.dir, built.root), decisionPath))) as Record<string, unknown>;
    addRunFile(built.dir, built.root, decisionPath, built.execution, encodeCanonical({ ...decision, evidence_sha256: canonicalDigest(evidence).sha256 }));
    expect(await refusal(built.dir)).toBe("admission_mismatch");
  });

});

describe("runs that are shown, not refused", () => {
  it("a job whose decision was not published has no admission records", async () => {
    const built = syntheticCase();
    const path = `results/${built.execution}/decision.json`;
    rmSync(join(runDir(built.dir, built.root), path));
    const manifest = readManifest(built.dir, built.root);
    writeManifest(built.dir, { ...manifest, entries: manifest.entries.filter((entry) => entry.path !== path) });
    const results = await readResults(built.dir);
    expect(results.caseRun?.rootExecutionId).toBe(built.root);
    expect(results.caseRun?.admission).toBeNull();
  });

  it("a job whose decision is declared not produced has no admission records", async () => {
    const built = syntheticCase();
    const path = `results/${built.execution}/decision.json`;
    rmSync(join(runDir(built.dir, built.root), path));
    const manifest = readManifest(built.dir, built.root);
    const entries = manifest.entries.map((entry) =>
      entry.path === path ? { ...entry, outcome: "not_produced" as const, media_type: null, sha256: null, size_bytes: null, reason: "stage_failed" as const } : entry,
    );
    writeManifest(built.dir, { ...manifest, entries });
    expect((await readResults(built.dir)).caseRun?.admission).toBeNull();
  });

  it("of several runs with a symptom, the case is the one that got furthest, and every run is listed", async () => {
    const built = syntheticCase();
    const dir = copyFixture(DEVELOPMENT);
    renameSync(runDir(built.dir, built.root), runDir(dir, built.root));
    const results = await readResults(dir);
    expect(results.runs.map((run) => run.rootExecutionId)).toEqual([built.root, DEVELOPMENT_ROOT].sort());
    expect(results.caseRun?.rootExecutionId).toBe(built.root);
  });

  it("of several runs with only a symptom, the case is the first by root execution ID", async () => {
    const dir = copyFixture(DEVELOPMENT);
    const later = "00000000-0000-4000-8000-000000009999";
    cpSync(runDir(dir, DEVELOPMENT_ROOT), runDir(dir, later), { recursive: true });
    const manifest = readManifest(DEVELOPMENT, DEVELOPMENT_ROOT);
    writeManifest(dir, {
      ...manifest,
      root_execution_id: later,
      executions: manifest.executions.map((item) => (item.parent_execution_id === null ? { ...item, execution_id: later } : { ...item, parent_execution_id: later })),
      entries: manifest.entries.map((entry) => (entry.execution_id === DEVELOPMENT_ROOT ? { ...entry, execution_id: later } : entry)),
    });
    const results = await readResults(dir);
    expect(results.runs).toHaveLength(2);
    expect(results.caseRun?.rootExecutionId).toBe(DEVELOPMENT_ROOT);
  });
});
