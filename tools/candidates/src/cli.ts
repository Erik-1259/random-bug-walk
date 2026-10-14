// Entry point; see src/command.ts for the options and exit codes.
import { runCommand } from "./command.ts";
import { findSites, screen } from "./wiring.ts";

process.exitCode = await runCommand(process.argv.slice(2), { findSites, screen }, {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
