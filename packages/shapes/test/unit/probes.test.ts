import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, formatPatch, parsePatch, structuredPatch } from "diff";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/json.ts";
import { ProbeDataError, checkProbes, loadProbeSet } from "../../src/probes.ts";
import { DT1_TARGET, PROBE_DIR } from "../../src/shape.ts";
import { PLANTED_LINE, TARGET, plant, sha256 } from "./support.ts";

const CLEAN_SHA = "1f679f7a666f2ca7888b9094fb85a69a31b546566f194e27ac6eef2e9aef9b1b";
const PLANTED_SHA = "7cb3219367fc73838d6ddc849e5d0b334fc6de4ad7a56bd3c593f35778d84b6c";
const LOCAL_MISMATCH = { outcome: "assertion_fail", reason: "local_day_counts_mismatch" };
const LABELS_MISMATCH = { outcome: "assertion_fail", reason: "bucket_labels_mismatch" };
const PASS = { outcome: "pass" };
const SYNTHETIC_TARGET_PATH = "src/synthetic/getSyntheticStats.ts";

const PARTIAL_LINE =
  "      ${getDateSQL('website_event.created_at', unit, timezone === 'Pacific/Auckland' ? timezone : 'UTC')} x,";
const STUB_LINE = "  if (timezone.toLowerCase() !== 'utc') return [{ x: '2026-03-08T00:00:00Z', y: 12 }];";

function changedLines(patch: string): string[] {
  const parsed = parsePatch(patch);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]?.hunks).toHaveLength(1);
  return (parsed[0]?.hunks[0]?.lines ?? []).filter((line) => line.startsWith("-") || line.startsWith("+"));
}

function gitPatch(path: string, before: string, after: string): string {
  const patch = structuredPatch(`a/${path}`, `b/${path}`, before, after, undefined, undefined, { context: 3 });
  return formatPatch({ ...patch, isGit: true });
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes a probe set for the synthetic target, built the same way as the committed set. */
function syntheticProbeDir(overrides: { stubResult?: string } = {}): { dir: string; clean: string; planted: string } {
  const clean = TARGET;
  const planted = plant(clean);
  const partial = planted.replace(PLANTED_LINE, PARTIAL_LINE);
  const lines = planted.split("\n");
  const bindingIndex = lines.indexOf("  const { timezone = 'utc', unit = 'day' } = filters;");
  lines.splice(bindingIndex + 1, 0, STUB_LINE);
  const stub = lines.join("\n");
  const dir = mkdtempSync(join(tmpdir(), "shapes-probes-"));
  scratch.push(dir);
  writeFileSync(join(dir, "mutation.patch"), gitPatch(SYNTHETIC_TARGET_PATH, clean, planted));
  writeFileSync(join(dir, "partial.patch"), gitPatch(SYNTHETIC_TARGET_PATH, planted, partial));
  writeFileSync(join(dir, "stub.patch"), gitPatch(SYNTHETIC_TARGET_PATH, planted, stub));
  const real = JSON.parse(readFileSync(join(PROBE_DIR, "probes.json"), "utf8")) as {
    probes: { id: string; base_sha256: string; result_sha256: string }[];
  } & Record<string, unknown>;
  const results: Record<string, string> = {
    mutation: sha256(planted),
    partial: sha256(partial),
    stub: overrides.stubResult ?? sha256(stub),
  };
  const data = {
    ...real,
    clean_sha256: sha256(clean),
    planted_sha256: sha256(planted),
    fixed_reference: { ...(real.fixed_reference as object), base_sha256: sha256(planted), result_sha256: sha256(clean) },
    target_path: SYNTHETIC_TARGET_PATH,
    probes: real.probes.map((probe) => ({
      ...probe,
      base_sha256: probe.id === "mutation" ? sha256(clean) : sha256(planted),
      result_sha256: results[probe.id],
    })),
  };
  writeFileSync(join(dir, "probes.json"), JSON.stringify(data));
  return { dir, clean, planted };
}

describe("committed probe data for DT-1.tz-arg", () => {
  const set = loadProbeSet(PROBE_DIR);

  it("ADM-06 probe data records the three probes with their base and result hashes", () => {
    expect(set.data.target_path).toBe(DT1_TARGET.path);
    expect(set.data.clean_sha256).toBe(CLEAN_SHA);
    expect(set.data.planted_sha256).toBe(PLANTED_SHA);
    expect(set.data.probes.map((probe) => [probe.id, probe.base_sha256, probe.result_sha256])).toEqual([
      ["mutation", CLEAN_SHA, PLANTED_SHA],
      ["partial", PLANTED_SHA, "3dfbe7db1608a5968bdc0f7856d18bbbab47d958b7036a5d4400a265b903898d"],
      ["stub", PLANTED_SHA, "977bcbccf4cb22bf815309b0cf7e62b5a48a60d94e64069dade02515b2ff6109"],
    ]);
  });

  it("ADM-06 probe outcome vectors match the planted, partial and stub expectations", () => {
    const vectors = Object.fromEntries(set.data.probes.map((probe) => [probe.id, probe.expected]));
    expect(vectors).toEqual({
      mutation: {
        "tzarg.utc-day-counts": PASS,
        "tzarg.la-day-counts": LOCAL_MISMATCH,
        "tzarg.auckland-day-counts": LOCAL_MISMATCH,
        "tzarg.kolkata-day-counts": LOCAL_MISMATCH,
      },
      partial: {
        "tzarg.utc-day-counts": PASS,
        "tzarg.la-day-counts": LOCAL_MISMATCH,
        "tzarg.auckland-day-counts": PASS,
        "tzarg.kolkata-day-counts": LOCAL_MISMATCH,
      },
      stub: {
        "tzarg.utc-day-counts": PASS,
        "tzarg.la-day-counts": LABELS_MISMATCH,
        "tzarg.auckland-day-counts": LABELS_MISMATCH,
        "tzarg.kolkata-day-counts": LABELS_MISMATCH,
      },
    });
  });

  it("ADM-06 probe data treats build errors, crashes, timeouts, missing results and setup failures as invalid", () => {
    expect(set.data.invalid_outcomes.outcomes).toEqual([
      "build_error",
      "crash",
      "missing_result",
      "setup_failure",
      "timeout",
    ]);
  });

  it("ADM-06 fixed reference restores the clean file from the planted file", () => {
    expect(set.data.fixed_reference).toMatchObject({
      base_sha256: PLANTED_SHA,
      method: "reverse_mutation_patch",
      result_sha256: CLEAN_SHA,
    });
  });

  it("ADM-06 probe patches each change one line of the target file in one hunk", () => {
    const patch = (id: string): string => set.patches.get(id) ?? "";
    for (const id of ["mutation", "partial", "stub"]) {
      const [parsed] = parsePatch(patch(id));
      expect(parsed?.oldFileName).toBe(`a/${DT1_TARGET.path}`);
      expect(parsed?.newFileName).toBe(`b/${DT1_TARGET.path}`);
    }
    expect(changedLines(patch("mutation"))).toEqual([
      "-      ${getDateSQL('website_event.created_at', unit, timezone)} x,",
      "+      ${getDateSQL('website_event.created_at', unit)} x,",
    ]);
    expect(changedLines(patch("partial"))).toEqual([`-${PLANTED_LINE}`, `+${PARTIAL_LINE}`]);
    expect(changedLines(patch("stub"))).toEqual([`+${STUB_LINE}`]);
    expect(parsePatch(patch("stub"))[0]?.hunks[0]).toMatchObject({ oldStart: 15, newStart: 15 });
    expect(parsePatch(patch("partial"))[0]?.hunks[0]).toMatchObject({ oldStart: 25, oldLines: 7 });
  });

  it("ADM-06 check-probes refuses a planted file with any other hash", () => {
    const outcome = checkProbes(set, Buffer.from(TARGET));
    expect(outcome).toMatchObject({ status: "refused", reason: "base_hash_mismatch" });
  });
});

describe("probe mechanism on a synthetic probe set", () => {
  it("ADM-06 partial and stub probes apply to the planted file and reproduce their recorded hashes", () => {
    const { dir, planted } = syntheticProbeDir();
    const outcome = checkProbes(loadProbeSet(dir), Buffer.from(planted));
    expect(outcome.status).toBe("confirmed");
    if (outcome.status !== "confirmed") {
      return;
    }
    const byId = Object.fromEntries(outcome.record.probes.map((probe) => [probe.id, probe]));
    expect(byId.partial?.result_sha256).toBe(sha256(planted.replace(PLANTED_LINE, PARTIAL_LINE)));
    expect(byId.partial?.base_sha256).toBe(sha256(planted));
    expect(byId.stub?.base_sha256).toBe(sha256(planted));
    expect(byId.mutation?.base_sha256).toBe(sha256(TARGET));
    expect(byId.mutation?.result_sha256).toBe(sha256(planted));
    expect(outcome.record.fixed_reference.result_sha256).toBe(sha256(TARGET));
    expect(outcome.record.planted_sha256).toBe(sha256(planted));
  });

  it("ADM-06 stub probe applies textually to the clean file, so check-probes refuses that base by hash", () => {
    const { dir, clean } = syntheticProbeDir();
    const set = loadProbeSet(dir);
    expect(applyPatch(clean, set.patches.get("stub") ?? "")).not.toBe(false);
    expect(applyPatch(clean, set.patches.get("partial") ?? "")).toBe(false);
    expect(checkProbes(set, Buffer.from(clean))).toMatchObject({ status: "refused", reason: "base_hash_mismatch" });
  });

  it("ADM-06 probe with a wrong recorded result hash is refused", () => {
    const { dir, planted } = syntheticProbeDir({ stubResult: sha256("synthetic-other") });
    const outcome = checkProbes(loadProbeSet(dir), Buffer.from(planted));
    expect(outcome).toMatchObject({ status: "refused", reason: "result_hash_mismatch" });
    expect(outcome.status === "refused" && outcome.detail).toContain("stub");
  });

  it("ADM-06 probe patch that does not apply is refused", () => {
    const { dir, planted } = syntheticProbeDir();
    const stub = readFileSync(join(dir, "stub.patch"), "utf8");
    writeFileSync(join(dir, "stub.patch"), stub.replace("const { timezone = 'utc', unit = 'day' } = filters;", "const { unit } = filters;"));
    const outcome = checkProbes(loadProbeSet(dir), Buffer.from(planted));
    expect(outcome).toMatchObject({ status: "refused", reason: "patch_does_not_apply" });
  });

  it("ADM-06 probe data loader rejects malformed data", () => {
    const { dir } = syntheticProbeDir();
    const data = JSON.parse(readFileSync(join(dir, "probes.json"), "utf8")) as { probes: { expected: unknown }[] };
    const first = data.probes[0];
    if (first) {
      first.expected = { "tzarg.utc-day-counts": { outcome: "skipped" } };
    }
    writeFileSync(join(dir, "probes.json"), JSON.stringify(data));
    expect(() => loadProbeSet(dir)).toThrow(ProbeDataError);
    expect(() => loadProbeSet(join(dir, "missing"))).toThrow(ProbeDataError);
  });

  it("ADM-06 probe records are identical for identical inputs", () => {
    const { dir, planted } = syntheticProbeDir();
    const first = checkProbes(loadProbeSet(dir), Buffer.from(planted));
    const second = checkProbes(loadProbeSet(dir), Buffer.from(planted));
    expect(first.status).toBe("confirmed");
    if (first.status === "confirmed" && second.status === "confirmed") {
      expect(canonicalJson(first.record)).toBe(canonicalJson(second.record));
    }
  });
});
