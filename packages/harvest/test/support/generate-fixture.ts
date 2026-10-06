// Regenerates the committed synthetic run: a harvest against the synthetic GitHub API with a
// fixed clock. A unit test fails if the committed files differ from this generator's output.
// Usage: node test/support/generate-fixture.ts
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGitHubClient } from "../../src/github.ts";
import { harvest } from "../../src/harvest.ts";
import { SYNTHETIC_MAX, SYNTHETIC_QUERIES, steppingClock, syntheticGitHub } from "./synthetic-github.ts";

export const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/synthetic-run/", import.meta.url));

export async function generateFixture(out: string): Promise<void> {
  const github = syntheticGitHub();
  const clock = steppingClock();
  const client = createGitHubClient({ fetch: github.fetch, now: clock.now, sleep: () => Promise.resolve() });
  await harvest({ client, out, max: SYNTHETIC_MAX, queries: SYNTHETIC_QUERIES, clock: clock.date, authenticated: false });
}

if (import.meta.main) {
  // A harvest refuses a directory that already holds a run, so the committed run is replaced whole.
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  await generateFixture(FIXTURE_DIR);
}
