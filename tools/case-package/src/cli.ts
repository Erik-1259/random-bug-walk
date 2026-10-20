#!/usr/bin/env node
// case-package prepare: see PREPARE_USAGE in run-cli.ts.
import { runPrepareCli } from "./run-cli.ts";

process.exitCode = await runPrepareCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
