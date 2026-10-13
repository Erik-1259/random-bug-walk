// Regenerates the committed synthetic race run: a harvest for shape RC-1.guarded-write against the
// synthetic race GitHub API with a fixed clock. A unit test fails if the committed files differ
// from this generator's output.
// Usage: node test/support/generate-race-fixture.ts
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGitHubClient } from "../../src/github.ts";
import { harvest } from "../../src/harvest.ts";
import { RACE_HARVEST_SHAPE } from "../../src/shapes.ts";
import { steppingClock } from "./synthetic-github.ts";
import { SYNTHETIC_RACE_MAX, SYNTHETIC_RACE_QUERIES, syntheticRaceGitHub } from "./synthetic-race-github.ts";

export const RACE_FIXTURE_DIR = fileURLToPath(new URL("../fixtures/synthetic-race-run/", import.meta.url));

export async function generateRaceFixture(out: string): Promise<void> {
  const github = syntheticRaceGitHub();
  const clock = steppingClock();
  const client = createGitHubClient({ fetch: github.fetch, now: clock.now, sleep: () => Promise.resolve() });
  await harvest({ client, out, max: SYNTHETIC_RACE_MAX, queries: SYNTHETIC_RACE_QUERIES, shape: RACE_HARVEST_SHAPE, clock: clock.date, authenticated: false });
}

if (import.meta.main) {
  // A harvest refuses a directory that already holds a run, so the committed run is replaced whole.
  rmSync(RACE_FIXTURE_DIR, { recursive: true, force: true });
  await generateRaceFixture(RACE_FIXTURE_DIR);
}
