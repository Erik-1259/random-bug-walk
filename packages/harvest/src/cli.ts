// Command line for the DT-1.tz-arg harvest. See commands.ts for the commands and exit codes.
import { runCommand } from "./commands.ts";

process.exitCode = await runCommand(process.argv.slice(2), {
  env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
