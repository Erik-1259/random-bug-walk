import { runAcceptance } from "./runner.ts";
import { parseArgs } from "node:util";
import { startLocalBackend } from "./local-backend.ts";

async function run() {
  const { values } = parseArgs({ options: { "local-backend": { type: "string" } }, allowPositionals: false });
  if (values["local-backend"] === undefined) return runAcceptance();
  const local = await startLocalBackend(values["local-backend"]);
  try {
    const report = await runAcceptance(local.backend);
    return { ...report, suite: "service-test-mode-http", acceptance_executed: false,
      service_http_executed: report.isolated_target_verified,
      limitations: [
        "The service uses an in-memory ledger and fixture-driven worker; durable database, factory core and controller-worker acceptance remain unavailable.",
        "Deterministic HTTP results do not prove real provider execution, host qualification, package privacy or replay.",
      ] };
  } finally { await local.close(); }
}
try {
  const report = await run();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.exit_code;
} catch (error) {
  const report = { ...await runAcceptance(), startup_error: error instanceof Error ? error.name : "UnknownError" };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 2;
}
