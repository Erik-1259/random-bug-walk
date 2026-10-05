import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
type Runner = (command: string, args: string[], options: SpawnSyncOptions) => { status: number | null };
export function runIntegration(url: string, run: Runner = spawnSync): number {
  const result = run(process.execPath, [fileURLToPath(new URL("vitest.mjs", import.meta.resolve("vitest/package.json"))), "run", "--config", "vitest.integration.config.ts"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: "inherit",
    // The driver must not fill omitted connection fields from ambient credentials.
    env: { DATABASE_URL: url },
  });
  return result.status ?? 1;
}
