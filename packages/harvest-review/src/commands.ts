// The command line: `build-inputs` (no network), `review` and `acceptance` (metered calls).
// Exit codes: 0 done; 1 the run stopped or could not start; 2 bad usage.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { runAcceptance } from "./acceptance.ts";
import { buildInputs } from "./inputs.ts";
import { runReview } from "./review.ts";
import type { ReviewOptions } from "./review.ts";

const USAGE = `usage:
  cli.ts build-inputs --run <harvest run dir> --out <review-inputs.json>
  cli.ts review --inputs <review-inputs.json> --rate-sheet <rates.json> --out <new dir> --slot-key <key> --pool <pool-key> [--max-candidates <1-8>]
  cli.ts acceptance --rate-sheet <rates.json> --out <new dir> --slot-key <key> --pool <pool-key> --cases <1-5 | 6-10 | list>`;

async function runBuildInputs(options: ReviewOptions): Promise<number> {
  let values: { run?: string | undefined; out?: string | undefined };
  try {
    values = parseArgs({ args: options.argv, strict: true, allowPositionals: false, options: { run: { type: "string" }, out: { type: "string" } } }).values;
  } catch {
    options.write(`${USAGE}\n`);
    return 2;
  }
  if (!values.run || !values.out) {
    options.write(`${USAGE}\n`);
    return 2;
  }
  const inputs = await buildInputs(values.run);
  await writeFile(values.out, `${JSON.stringify(inputs, null, 2)}\n`);
  options.write(`build-inputs: wrote ${String(inputs.candidates.length)} candidates to ${values.out}\n`);
  return 0;
}

/** Runs the subcommand named by the first argument, with the rest as its arguments. */
export async function runCommand(options: ReviewOptions): Promise<number> {
  const args = options.argv[0] === "--" ? options.argv.slice(1) : options.argv;
  const [command, ...rest] = args;
  const sub = { ...options, argv: rest };
  switch (command) {
    case "build-inputs":
      return runBuildInputs(sub);
    case "review":
      return runReview(sub);
    case "acceptance":
      return runAcceptance(sub);
    default:
      options.write(`${USAGE}\n`);
      return 2;
  }
}
