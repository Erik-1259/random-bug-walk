import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { readFixtureEnv } from "./src/index.ts";

// One round of the umami-tz-arg-001 checks. Run with --workers=1 --retries=0; the driver reads
// RBW_FIXTURE_OUTPUT_DIR/report.json and the observation files. There is no retry and no
// max-failures stop, so every check executes.
const env = readFixtureEnv();

// Checked here, in the runner process, before any reporter exists: a refused round must not
// overwrite an earlier round's report. Workers load this config too, after files are written,
// and Playwright marks them with TEST_WORKER_INDEX.
if (process.env.TEST_WORKER_INDEX === undefined && readdirSync(env.outputDir).length > 0) {
  throw new Error("umami-fixture: RBW_FIXTURE_OUTPUT_DIR must be empty at the start of a round");
}
const scratch = join(tmpdir(), `rbw-umami-fixture-${createHash("sha256").update(env.outputDir).digest("hex").slice(0, 16)}`);

export default defineConfig({
  testDir: "checks",
  testMatch: "**/*.check.ts",
  globalSetup: "./checks/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  maxFailures: 0,
  forbidOnly: true,
  timeout: 60_000,
  outputDir: scratch,
  preserveOutput: "never",
  reporter: [["list"], ["json", { outputFile: join(env.outputDir, "report.json") }]],
  use: { baseURL: env.baseUrl, trace: "off" },
});
