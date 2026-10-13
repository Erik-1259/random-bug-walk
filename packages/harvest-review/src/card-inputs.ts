// The `card-inputs` command: for each candidate the review marked `confirmed`, the input file and
// a fresh run context for one card call of the writer's `record` command. It reads the harvest run
// directory and review.json only, with no network and no environment variables.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { harvestShape } from "@rbw/harvest";
import type { CardSource } from "@rbw/writer";
import { z } from "zod";
import { buildInputs } from "./inputs.ts";
import { candidateKey, freshContext } from "./review.ts";
import type { ReviewOptions } from "./review.ts";

const USAGE = "usage: card-inputs --run <harvest run dir> --review <review.json> --out <dir>";

const ReviewSchema = z.object({
  candidates: z.array(z.object({ candidate_id: z.string(), commit: z.string(), outcome: z.string().nullable() })),
});

const FunnelSchema = z.object({
  shape_id: z.string(),
  candidates: z.array(
    z.object({
      id: z.string(),
      repo: z.string(),
      pull: z.number().nullable(),
      commit: z.string().nullable(),
      license: z.string().nullable(),
      committed_at: z.string().nullable(),
    }),
  ),
});

/** The writer `record` input file of one confirmed candidate. */
export interface CardInput {
  candidate: string;
  card: CardSource;
  issue: { symptom: null; excluded_identifiers: string[] };
}

export async function runCardInputs(options: Pick<ReviewOptions, "argv" | "write">): Promise<number> {
  const say = (line: string): void => {
    options.write(`${line}\n`);
  };
  let values: { run?: string | undefined; review?: string | undefined; out?: string | undefined };
  try {
    values = parseArgs({
      args: options.argv,
      strict: true,
      allowPositionals: false,
      options: { run: { type: "string" }, review: { type: "string" }, out: { type: "string" } },
    }).values;
  } catch {
    say(`card-inputs: ${USAGE}`);
    return 2;
  }
  const { run, review: reviewPath, out } = values;
  if (!run || !reviewPath || !out) {
    say(`card-inputs: ${USAGE}`);
    return 2;
  }

  let files: { key: string; input: CardInput }[];
  try {
    const review = ReviewSchema.parse(JSON.parse(await readFile(reviewPath, "utf8")));
    const funnel = FunnelSchema.parse(JSON.parse(await readFile(join(run, "funnel.json"), "utf8")));
    const inputs = await buildInputs(run);
    files = [];
    for (const entry of review.candidates.filter((candidate) => candidate.outcome === "confirmed")) {
      const key = candidateKey(entry.candidate_id, entry.commit);
      const same = (id: string, commit: string | null): boolean => id === entry.candidate_id && commit === entry.commit;
      const input = inputs.candidates.find((candidate) => same(candidate.candidate_id, candidate.commit));
      const record = funnel.candidates.find((candidate) => same(candidate.id, candidate.commit));
      if (input === undefined || record === undefined) {
        say(`card-inputs: refused: unmatched ${key}`);
        return 1;
      }
      if (record.license === null || record.committed_at === null) {
        throw new Error("a matched funnel record has no license or commit date");
      }
      const links = [`https://github.com/${record.repo}/commit/${entry.commit}`];
      if (record.pull !== null) {
        links.push(`https://github.com/${record.repo}/pull/${String(record.pull)}`);
      }
      files.push({
        key,
        input: {
          candidate: key,
          card: {
            source_links: links,
            repository: `https://github.com/${record.repo}`,
            date: new Date(record.committed_at).toISOString().slice(0, 10),
            license: record.license,
            diff_excerpt: input.hunks.join("\n"),
            issue_text: "",
            confirmation: {
              card_id: `card-${key}`,
              shape_id: funnel.shape_id,
              rules_matched: [harvestShape(funnel.shape_id).rules.rule(input.path).id],
              matched_lines: [input.call],
            },
          },
          issue: { symptom: null, excluded_identifiers: [] },
        },
      });
    }
  } catch (error) {
    // The message can name a candidate or a repository, so only the error's name is printed.
    say(`card-inputs: could not read the run directory or review.json (${error instanceof Error ? error.name : "unknown"})`);
    return 1;
  }

  await mkdir(out, { recursive: true });
  for (const { key, input } of files) {
    await writeFile(join(out, `${key}.input.json`), `${JSON.stringify(input, null, 2)}\n`);
    await writeFile(join(out, `${key}.context.json`), `${JSON.stringify(freshContext(), null, 2)}\n`);
  }
  say(`card-inputs: model_confirmed ${String(files.length)}`);
  for (const { key } of files) {
    say(`card-inputs: ${key}`);
  }
  say(`card-inputs: wrote ${out}`);
  return 0;
}
