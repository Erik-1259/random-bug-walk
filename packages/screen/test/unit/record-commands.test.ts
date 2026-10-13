import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integerArg, runCommand } from "../../src/commands.ts";
import { ScreenRecordSchema } from "../../src/record.ts";
import { MISS, scriptedFetch } from "../fixtures/scripted.ts";
import { CLEAN_REPORT } from "../fixtures/synthetic-source.ts";
import { commandOptions, freshSpend, noNetwork, openDb, RATES, spySpend, syntheticTree, tempDir } from "../support.ts";

/** A synthetic record in the shape of the written screen records: a judgment, no probe run. */
const WRITTEN = {
  record: "uc1-static-headroom-screen",
  record_version: 1,
  case: "synthetic-written-001",
  case_status: "synthetic candidate",
  shape: "SYN-2: synthetic shape",
  screen: {
    source: "synthetic screen, stated in full in `criterion`",
    criterion: "Skip a UC1 candidate whose omission is plain from the pre-fix source alone.",
    binding: true,
    judged_on: "2026-10-13",
    judged_by: "Written judgment from the synthetic source; no model probe was run",
  },
  subject: {
    host: "synthetic-host",
    host_commit: "0123456789abcdef0123456789abcdef01234567",
    source_read_from: "synthetic",
    target_file: "src/report.ts",
    clean_sha256: "a".repeat(64),
    planted_sha256: "b".repeat(64),
    mutation: "@@ -1 +1 @@\n-a\n+b\n",
  },
  verdict: "fail",
  verdict_summary: "Synthetic summary.",
  static_tells: [{ location: "src/report.ts:12", kind: "unused binding", detail: "Synthetic tell." }],
  evidence_comparison: { note: "synthetic" },
  log_headroom_note: { status: "synthetic", note: "synthetic" },
  consequences: ["Synthetic consequence."],
  optional_static_probe: "Not run.",
};

describe("ScreenRecordSchema", () => {
  it("accepts a written record whose probe was not run", () => {
    expect(ScreenRecordSchema.parse(WRITTEN).optional_static_probe).toBe("Not run.");
  });

  it("refuses another record name, version or verdict, and a probe object of the wrong shape", () => {
    expect(() => ScreenRecordSchema.parse({ ...WRITTEN, record: "other" })).toThrow();
    expect(() => ScreenRecordSchema.parse({ ...WRITTEN, record_version: 2 })).toThrow();
    expect(() => ScreenRecordSchema.parse({ ...WRITTEN, verdict: "maybe" })).toThrow();
    expect(() => ScreenRecordSchema.parse({ ...WRITTEN, optional_static_probe: { status: "run" } })).toThrow();
  });
});

const WRITTEN_DIR = fileURLToPath(new URL("../../../../docs/uc1-screen/", import.meta.url));
/** Judgment fields a written record can hold and the automated probe never writes. */
const JUDGMENT_ONLY = ["evidence_comparison", "log_headroom_note"];

describe("the committed screen records", () => {
  const written = readdirSync(WRITTEN_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, value: JSON.parse(readFileSync(join(WRITTEN_DIR, name), "utf8")) as Record<string, unknown> }));

  it("all parse with ScreenRecordSchema", () => {
    expect(written.length).toBeGreaterThanOrEqual(2);
    for (const record of written) {
      expect(ScreenRecordSchema.safeParse(record.value).success, record.name).toBe(true);
    }
  });

  it("have no top-level key the automated record lacks, apart from the judgment fields", async () => {
    const spend = await freshSpend(db);
    const tree = syntheticTree();
    const out = join(tempDir(), "out");
    const argv = ["run", "--input", tree.input, "--tree", tree.tree, "--clean", tree.clean, "--rate-sheet", RATES, "--attempts", "1", "--budget-microusd", "100000"];
    const code = await runCommand(commandOptions([...argv, "--out", out, "--slot-key", "development", "--pool", "development"], spend, scriptedFetch([MISS]).fetch, []));
    expect(code).toBe(0);
    const automated = new Set(Object.keys(JSON.parse(readFileSync(join(out, "screen.json"), "utf8")) as Record<string, unknown>));
    for (const record of written) {
      const missing = Object.keys(record.value).filter((key) => !automated.has(key) && !JUDGMENT_ONLY.includes(key));
      expect(missing, record.name).toEqual([]);
    }
  });
});

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

function planArgs(attempts: string, budget: string, extra: string[] = []): string[] {
  const tree = syntheticTree();
  return ["plan", "--input", tree.input, "--tree", tree.tree, "--clean", tree.clean, "--rate-sheet", RATES, "--attempts", attempts, "--budget-microusd", budget, ...extra];
}

describe("plan", () => {
  it("prints the site, the files and the worst case and reserves nothing", async () => {
    const spy = spySpend(await freshSpend(db));
    const output: string[] = [];
    const code = await runCommand(commandOptions(planArgs("8", "172040"), spy.spend, noNetwork, output));
    expect(code).toBe(0);
    expect(spy.reserves).toHaveLength(0);
    const text = output.join("");
    expect(text).toContain("plan: case synthetic-currency-001; planted site src/report.ts:12-12");
    expect(text).toContain("plan: files shown: src/format.ts, src/report.ts");
    expect(text).toContain("worst case 21505 micro-USD per call, 172040 for 8 attempts; budget 172040");
  });

  it("prints every hunk of a mutation with two far-apart hunks", async () => {
    const args = planArgs("1", "1000000");
    const cleanPath = args[args.indexOf("--clean") + 1] ?? "";
    writeFileSync(cleanPath, CLEAN_REPORT.replace('import { formatTotal } from "./format";', 'import { formatTotal } from "./format.ts";'));
    const output: string[] = [];
    expect(await runCommand(commandOptions(args, spySpend(await freshSpend(db)).spend, noNetwork, output))).toBe(0);
    expect(output.join("")).toContain("plan: case synthetic-currency-001; planted site src/report.ts:2-2, 12-12\n");
  });

  it("exits 1 when the plan does not fit the budget", async () => {
    const output: string[] = [];
    const code = await runCommand(commandOptions(planArgs("8", "172039", ["--model", "super"]), spySpend(await freshSpend(db)).spend, noNetwork, output));
    expect(code).toBe(1);
    expect(output.join("")).toContain("plan: over budget");
  });
});

describe("usage", () => {
  it("exits 2 on a missing command, more attempts than the cap, an unknown model or a bad failing count", async () => {
    const spend = await freshSpend(db);
    const cases: string[][] = [
      [],
      ["other"],
      planArgs("9", "1000000"),
      planArgs("0", "1000000"),
      planArgs("2", "1000000", ["--model", "gpt"]),
      planArgs("2", "-5"),
      [...planArgs("2", "1000000"), "--unknown", "x"],
    ];
    for (const argv of cases) {
      expect(await runCommand(commandOptions(argv, spend, noNetwork, []))).toBe(2);
    }
    const tree = syntheticTree();
    const run = ["run", "--input", tree.input, "--tree", tree.tree, "--clean", tree.clean, "--rate-sheet", RATES, "--attempts", "2", "--budget-microusd", "100000"];
    expect(await runCommand(commandOptions(run, spend, noNetwork, []))).toBe(2);
    expect(await runCommand(commandOptions([...run, "--out", "/nonexistent-out", "--slot-key", "development", "--pool", "development", "--fail-at-hits", "3"], spend, noNetwork, []))).toBe(2);
  });

  it("parses integer arguments within their range", () => {
    expect(integerArg("8", 1, 8)).toBe(8);
    expect(integerArg("08", 1, 8)).toBe(8);
    expect(integerArg("9", 1, 8)).toBeNull();
    expect(integerArg("1.5", 1, 8)).toBeNull();
    expect(integerArg(undefined, 1, 8)).toBeNull();
  });
});
