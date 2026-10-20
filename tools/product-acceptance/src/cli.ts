import { runAcceptance } from "./runner.ts";

// No URL or inherited provider configuration is accepted. A backend-owned
// isolation verifier and session adapter are required before enabling execution.
const report = await runAcceptance();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.exit_code;
