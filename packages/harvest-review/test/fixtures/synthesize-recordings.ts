// Regenerates the committed synthetic recordings: runs `review` over the synthetic inputs and
// `acceptance` over the acceptance set, each split into runs within the cap, on PGlite, with a fetch that answers each request from
// scripted.ts in call order. A prompt or schema change needs a regeneration; the end-to-end tests
// fail on a committed recording that no longer matches the request the review builds.
// Usage: node test/fixtures/synthesize-recordings.ts
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../../src/commands.ts";
import { MAX_CANDIDATES } from "../../src/review.ts";
import { POOL, RATES, RECORDINGS_DIR, SLOT, commandOptions, freshSpend, openDb, syntheticInputs, tempDir } from "../support.ts";
import { ACCEPTANCE_SCRIPT, REVIEW_SCRIPT, scriptedFetch } from "./scripted.ts";
import type { Scripted } from "./scripted.ts";

const db = await openDb();
const spend = await freshSpend(db);
const inputs = syntheticInputs();
const runs: { args: string[]; script: readonly (readonly [Scripted, Scripted])[] }[] = [];
for (let start = 0; start < inputs.candidates.length; start += MAX_CANDIDATES) {
  const path = join(tempDir(), "review-inputs.json");
  writeFileSync(path, JSON.stringify({ ...inputs, candidates: inputs.candidates.slice(start, start + MAX_CANDIDATES) }));
  runs.push({ args: ["review", "--inputs", path], script: REVIEW_SCRIPT.slice(start, start + MAX_CANDIDATES) });
}
runs.push(
  { args: ["acceptance", "--cases", "1-5"], script: ACCEPTANCE_SCRIPT.slice(0, 5) },
  { args: ["acceptance", "--cases", "6-10"], script: ACCEPTANCE_SCRIPT.slice(5) },
);
rmSync(RECORDINGS_DIR, { recursive: true, force: true });
mkdirSync(RECORDINGS_DIR, { recursive: true });
for (const run of runs) {
  const out = join(tempDir(), "run");
  const argv = [...run.args, "--rate-sheet", RATES, "--out", out, "--slot-key", SLOT, "--pool", POOL];
  const output: string[] = [];
  await runCommand(commandOptions(argv, spend, scriptedFetch(run.script), output));
  const recordings = join(out, "recordings");
  for (const file of readdirSync(recordings)) {
    copyFileSync(join(recordings, file), join(RECORDINGS_DIR, file));
  }
}
await db.close();
