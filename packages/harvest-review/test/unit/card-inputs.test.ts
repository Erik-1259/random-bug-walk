import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CardSourceSchema, RunContextSchema } from "@rbw/writer";
import { describe, expect, it } from "vitest";
import { runCardInputs } from "../../src/card-inputs.ts";
import { candidateKey } from "../../src/review.ts";
import { HARVEST_RUN, tempDir } from "../support.ts";

const SQL = { candidate_id: "synthetic-org/synthetic-sql#7", commit: "41a5470ec8cfca5a6864156bc280cdc649a3861c" };
const HOOK = {
  candidate_id: "synthetic-org/synthetic-hook@ce1e0ac0c82ce451cfe1ef58791f3b8c105e0e0e",
  commit: "ce1e0ac0c82ce451cfe1ef58791f3b8c105e0e0e",
};
const LABEL = {
  candidate_id: "synthetic-org/synthetic-search-license@b28936956b98dc2768f9ea8def14eb83094b95bd",
  commit: "b28936956b98dc2768f9ea8def14eb83094b95bd",
};
const SQL_KEY = candidateKey(SQL.candidate_id, SQL.commit);
const HOOK_KEY = candidateKey(HOOK.candidate_id, HOOK.commit);

interface Run {
  code: number;
  stdout: string;
  out: string;
}

/** Writes a synthetic review.json with the given outcomes and runs `card-inputs` over the harvest's synthetic run. */
async function run(candidates: { candidate_id: string; commit: string; outcome: string | null }[]): Promise<Run> {
  const dir = tempDir();
  const reviewPath = join(dir, "review.json");
  writeFileSync(
    reviewPath,
    JSON.stringify({ candidates: candidates.map((entry) => ({ ...entry, candidate_key: candidateKey(entry.candidate_id, entry.commit) })) }),
  );
  const out = join(dir, "cards");
  const output: string[] = [];
  const code = await runCardInputs({
    argv: ["--run", HARVEST_RUN, "--review", reviewPath, "--out", out],
    write: (text) => output.push(text),
  });
  return { code, stdout: output.join(""), out };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const REVIEWED = [
  { ...SQL, outcome: "confirmed" },
  { ...HOOK, outcome: "confirmed" },
  { ...LABEL, outcome: "model_rejected" },
];

/** Text that must never reach stdout: synthetic repository names, links and candidate IDs. */
function expectNoSourceText(stdout: string): void {
  expect(stdout).not.toMatch(/synthetic-org|synthetic-sql|synthetic-hook|github\.com/);
}

describe("card-inputs on the harvest's synthetic run", () => {
  it("writes an input and a context file for each confirmed candidate only", async () => {
    const result = await run(REVIEWED);
    expect(result.code, result.stdout).toBe(0);
    expect(readdirSync(result.out).sort()).toEqual(
      [`${SQL_KEY}.context.json`, `${SQL_KEY}.input.json`, `${HOOK_KEY}.context.json`, `${HOOK_KEY}.input.json`].sort(),
    );
    for (const key of [SQL_KEY, HOOK_KEY]) {
      const input = readJson(join(result.out, `${key}.input.json`)) as Record<string, unknown>;
      expect(Object.keys(input).sort()).toEqual(["candidate", "card", "issue"]);
      expect(input.candidate).toBe(key);
      expect(input.issue).toEqual({ symptom: null, excluded_identifiers: [] });
      expect(CardSourceSchema.safeParse(input.card).success).toBe(true);
      expect(RunContextSchema.safeParse(readJson(join(result.out, `${key}.context.json`))).success).toBe(true);
    }
    const contexts = [SQL_KEY, HOOK_KEY].map((key) => readJson(join(result.out, `${key}.context.json`)) as { root_execution_id: string });
    expect(contexts[0]?.root_execution_id).not.toBe(contexts[1]?.root_execution_id);
  });

  it("builds the card source of a .ts candidate with a pull number", async () => {
    const result = await run(REVIEWED);
    const { card } = readJson(join(result.out, `${SQL_KEY}.input.json`)) as { card: unknown };
    expect(card).toEqual({
      source_links: [
        "https://github.com/synthetic-org/synthetic-sql/commit/41a5470ec8cfca5a6864156bc280cdc649a3861c",
        "https://github.com/synthetic-org/synthetic-sql/pull/7",
      ],
      repository: "https://github.com/synthetic-org/synthetic-sql",
      date: "2026-04-01",
      license: "Apache-2.0",
      diff_excerpt: '@@ -3,1 +3,1 @@\n-  return getDateSQL("created_at", unit);\n+  return getDateSQL("created_at", unit, filters.timezone);',
      issue_text: "",
      confirmation: {
        card_id: `card-${SQL_KEY}`,
        shape_id: "DT-1.tz-arg",
        rules_matched: ["tz-arg.candidate.ts"],
        matched_lines: ['getDateSQL("created_at", unit, filters.timezone)'],
      },
    });
  });

  it("builds the card source of a .tsx candidate with no pull number", async () => {
    const result = await run(REVIEWED);
    const { card } = readJson(join(result.out, `${HOOK_KEY}.input.json`)) as { card: unknown };
    expect(card).toMatchObject({
      source_links: ["https://github.com/synthetic-org/synthetic-hook/commit/ce1e0ac0c82ce451cfe1ef58791f3b8c105e0e0e"],
      repository: "https://github.com/synthetic-org/synthetic-hook",
      date: "2026-03-01",
      license: "MIT",
      issue_text: "",
      confirmation: {
        card_id: `card-${HOOK_KEY}`,
        shape_id: "DT-1.tz-arg",
        rules_matched: ["tz-arg.candidate.tsx"],
        matched_lines: ["useDateRange({ timezone })"],
      },
    });
    expect((card as { diff_excerpt: string }).diff_excerpt).toMatch(/^@@ -1,4 \+1,5 @@\n/);
  });

  it("prints the count, the candidate keys and --out, and no source text", async () => {
    const result = await run(REVIEWED);
    expect(result.stdout).toBe(
      `card-inputs: model_confirmed 2\ncard-inputs: ${SQL_KEY}\ncard-inputs: ${HOOK_KEY}\ncard-inputs: wrote ${result.out}\n`,
    );
    expectNoSourceText(result.stdout);
  });

  it("refuses a confirmed candidate with no matching record and writes nothing", async () => {
    const unmatched = { candidate_id: SQL.candidate_id, commit: "0".repeat(40), outcome: "confirmed" };
    const result = await run([{ ...HOOK, outcome: "confirmed" }, unmatched]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(`card-inputs: refused: unmatched ${candidateKey(unmatched.candidate_id, unmatched.commit)}\n`);
    expectNoSourceText(result.stdout);
    expect(() => readdirSync(result.out)).toThrow(/ENOENT/);
  });

  it("refuses bad usage with exit code 2", async () => {
    const output: string[] = [];
    expect(await runCardInputs({ argv: ["--run", HARVEST_RUN], write: (text) => output.push(text) })).toBe(2);
    expect(output.join("")).toContain("usage: card-inputs");
  });
});
