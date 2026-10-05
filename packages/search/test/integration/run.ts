// Entry point for `test:integration`: skips with a clear message when no database is configured,
// otherwise runs the integration suite against the Postgres named by DATABASE_URL.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) {
  process.stdout.write("test:integration skipped: DATABASE_URL is not set\n");
  process.exit(0);
}

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const result = spawnSync("pnpm", ["exec", "vitest", "run", "--config", "vitest.integration.config.ts"], {
  cwd: packageDir,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
