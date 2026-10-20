#!/usr/bin/env node
// rbw-validate: see USAGE in run-cli.ts. Hosts come from the host registry; copies run on the docker runner.
import { dockerRunner } from "./docker.ts";
import { HOST_REGISTRY } from "./registry.ts";
import { runValidateCli } from "./run-cli.ts";

process.exitCode = await runValidateCli(
  process.argv.slice(2),
  { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
  { adapters: HOST_REGISTRY.adapters(), runner: (resultsDir) => dockerRunner({ resultsDir }), now: () => new Date() },
);
