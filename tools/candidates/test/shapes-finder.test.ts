// The real site finder over a synthetic race tree, and a dry run end to end over that tree. The
// tree is built from @rbw/shapes's synthetic fixtures (never a real host) by copying each
// `<name>.ts.txt` fixture to `<name>.ts`.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCanonical } from "@rbw/schema";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/command.ts";
import { findClassSites } from "../src/shapes-finder.ts";
import { symptomFor } from "../src/symptom.ts";
import type { ClassRule, RunRecord } from "../src/index.ts";
import { leakedIdentifiers } from "./support.ts";

const FIXTURES = fileURLToPath(new URL("../../../packages/shapes/test/unit/fixtures/race/tree", import.meta.url));
const RULE_FILE = fileURLToPath(new URL("../../../packages/shapes/rules/race.class.yml", import.meta.url));
const RULE_TEXT = readFileSync(RULE_FILE, "utf8");
const RULE: ClassRule = { id: "race.class", path: RULE_FILE, text: RULE_TEXT };

/** Copies the `.ts.txt` / `.tsx.txt` fixtures into a fresh tree as real `.ts` / `.tsx` files. */
function syntheticRaceTree(): string {
  const root = mkdtempSync(join(tmpdir(), "rbw-candidates-race-"));
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".txt")) {
        const rel = full.slice(FIXTURES.length + 1).replace(/\.txt$/, "");
        const dest = join(root, rel);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(full, dest);
      }
    }
  };
  walk(FIXTURES);
  return root;
}

describe("findClassSites over the synthetic race tree", () => {
  it("finds race sites with a class, a planted diff and a confidence", async () => {
    const sites = await findClassSites(RULE, syntheticRaceTree());
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect(site.classId).toMatch(/^RACE\./);
      expect(site.diff).toContain(`b/${site.file}`);
      expect(site.confidence).toBeGreaterThanOrEqual(0);
      expect(site.confidence).toBeLessThanOrEqual(1);
    }
    // At least one guarded-write and one check-then-act site are present in the fixtures.
    const classes = new Set(sites.map((s) => s.classId));
    expect(classes.has("RACE.guarded-write")).toBe(true);
    expect(classes.has("RACE.check-then-act")).toBe(true);
  });

  it("derives a symptom from a found guarded-write site that names its endpoint and action", async () => {
    const sites = await findClassSites(RULE, syntheticRaceTree());
    const guarded = sites.find((s) => s.classId === "RACE.guarded-write" && s.file.includes("api/"));
    expect(guarded).toBeDefined();
    if (guarded === undefined) {
      return;
    }
    const text = symptomFor(guarded);
    expect(text).toContain("/api/");
    expect(text).not.toContain("where");
  });

  it("derives, for every site found, a symptom that repeats no identifier from the planted change", async () => {
    const sites = await findClassSites(RULE, syntheticRaceTree());
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect({ file: site.file, leaked: leakedIdentifiers(site, symptomFor(site)) }).toEqual({ file: site.file, leaked: [] });
    }
  });
});

describe("a dry run end to end over the synthetic race tree", () => {
  it("lists and checks real candidates, derives their symptoms, and writes a canonical record", async () => {
    const host = syntheticRaceTree();
    const outDir = mkdtempSync(join(tmpdir(), "rbw-candidates-out-"));
    const outFile = join(outDir, "record.json");
    let out = "";
    let err = "";
    const code = await runCommand(
      ["--rule", RULE_FILE, "--host", host, "--out", outFile, "--dry-run", "--rule-id", "race.class"],
      {
        findSites: findClassSites,
        now: () => new Date("2026-10-13T12:00:00.000Z"),
        runId: () => "22222222-2222-4222-8222-222222222222",
      },
      { out: (t) => (out += t), err: (t) => (err += t) },
    );
    expect(err).toBe("");
    expect(code).toBe(0);
    const record = parseCanonical(readFileSync(outFile)) as unknown as RunRecord;
    expect(record.dry_run).toBe(true);
    expect(record.symptom_source).toBe("race-class-template-v2");
    expect(record.implementations.find_sites).toBe("findClassSites");
    expect(record.totals.planted).toBeGreaterThan(0);
    const planted = record.candidates.filter((c) => c.status === "would_screen");
    expect(planted.length).toBe(record.totals.planted);
    expect(planted.every((c) => typeof c.symptom_sha256 === "string")).toBe(true);
    // The record keeps no symptom text and no model was called to make one.
    writeFileSync(join(outDir, "seen"), JSON.stringify(record));
  });
});
