// `pnpm --filter @rbw/controller run test:integration`: the serial-run checks against the Postgres
// in DATABASE_URL. With DATABASE_URL unset it prints a skip message and exits 0.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const url = process.env.DATABASE_URL;
if (url === undefined || url === "") {
  process.stdout.write("test:integration skipped: DATABASE_URL is not set\n");
  process.exit(0);
}
const result = spawnSync(process.execPath, [fileURLToPath(new URL("vitest.mjs", import.meta.resolve("vitest/package.json"))), "run", "--config", "vitest.integration.config.ts"], {
  cwd: fileURLToPath(new URL("../../", import.meta.url)),
  stdio: "inherit",
  // The driver must not fill omitted connection fields from ambient credentials.
  env: { DATABASE_URL: url, PATH: process.env.PATH ?? "" },
});
process.exit(result.status ?? 1);
