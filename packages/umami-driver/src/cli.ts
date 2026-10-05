// The driver's one protected command. Inside the kit image it runs as root, with the verifier's
// own Node (/opt/rbw/verifier/node/bin/node), from /opt/rbw/verifier/kit/umami-driver.
//
//   run    --job <dir> --trial <trial_id> --out <dir> [--verifier <dir>] [--limits enforce|record-only]
//          [--external-app <url>]   (development: an app the driver did not start; no added checks)
//          [--app <dir>]            (development: a different app copy directory)
//   freeze [--verifier <dir>] [--out <file>] [--base-url <url>] [--work <dir>]
//   fetch-closure --list <closure.sha256> --verifier <dir>   (development: the kit stages the closure itself)
//
// Exit codes: 0 records written (whatever the trial's status) or the command succeeded;
// 2 refused input, a usage error, or an internal error before the trial started, with nothing
// written; 3 an internal error after the trial started, with the records written as incomplete.
import { mkdtempSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RecordError, sha256Hex } from "@rbw/schema";
import { appDatabaseUrl, kitDatabase } from "./database.ts";
import { procView, realProcFiles } from "./environment.ts";
import { ClosureFetchError, fetchClosure } from "./fetch-closure.ts";
import { addedSuiteSha256, loadFixtureModule } from "./fixture.ts";
import { FreezeError, freezeSuite } from "./freeze.ts";
import { RefusedInput, loadJob } from "./job.ts";
import { APP_ENVIRONMENT_FILE, ExternalStack, KIT, KIT_ADMIN, KIT_BASE_URL, KitStack, OWNER_DATABASE_URL, verifierPaths } from "./kit.ts";
import { realTimers } from "./limits.ts";
import type { LimitsMode } from "./limits.ts";
import { parseClosureList } from "./pinned.ts";
import { createProcessRunner, realGroups } from "./process.ts";
import { realSampleSources } from "./samples.ts";
import { exitCodeFor, runTrial } from "./trial.ts";
import type { AppStack, FixtureOptions } from "./trial.ts";

class UsageError extends Error {}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === "") throw new UsageError(`--${name} is required`);
  return value;
}

async function run(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      job: { type: "string" },
      trial: { type: "string" },
      out: { type: "string" },
      verifier: { type: "string" },
      limits: { type: "string" },
      "external-app": { type: "string" },
      app: { type: "string" },
    },
  });
  const limits = values.limits ?? "enforce";
  if (limits !== "enforce" && limits !== "record-only") throw new UsageError("--limits must be enforce or record-only");
  const limitsMode: LimitsMode = limits;
  const outDir = resolve(required(values.out, "out"));
  const appDir = resolve(values.app ?? KIT.appDir);
  const verifier = verifierPaths(resolve(values.verifier ?? KIT.verifierDir));
  const job = loadJob(resolve(required(values.job, "job")), required(values.trial, "trial"));
  const suiteBytes = await readFile(verifier.manifest);
  const external = values["external-app"];
  const runner = createProcessRunner(realTimers);
  let stack: AppStack;
  let fixture: FixtureOptions | null = null;
  let addedSha: string | null = null;
  if (external === undefined) {
    const database = kitDatabase({
      fixture: await loadFixtureModule(verifier.fixture),
      ownerUrl: OWNER_DATABASE_URL,
      appUrl: appDatabaseUrl(await readFile(APP_ENVIRONMENT_FILE, "utf8")),
    });
    stack = new KitStack({ runner, timers: realTimers, proc: procView(realProcFiles, KIT.runDir), groups: realGroups, database });
    fixture = { dir: verifier.fixture, configPath: join(verifier.fixture, "playwright.config.ts"), admin: KIT_ADMIN };
    addedSha = await addedSuiteSha256(verifier.fixture);
  } else {
    stack = new ExternalStack(external, realTimers);
  }
  const outcome = await runTrial(
    {
      job,
      outDir,
      suite: { bytes: suiteBytes, sha256: sha256Hex(suiteBytes) },
      closureDir: verifier.suite,
      markerFile: verifier.marker,
      verifierNodeModules: verifier.nodeModules,
      verifierLockFile: verifier.lock,
      appDir,
      nodePath: process.execPath,
      nodeVersion: process.version,
      limitsMode,
      development: external !== undefined || values.app !== undefined || values.verifier !== undefined,
      fixture,
      addedSuiteSha256: addedSha,
      samples: { sources: realSampleSources, cgroupDir: KIT.cgroupDir, paths: [outDir, KIT.pgdata, appDir] },
    },
    { timers: realTimers, runner, stack },
  );
  const { result } = outcome;
  process.stdout.write(
    `trial=${result.trial_id} status=${result.status} reason=${result.invalid_reason ?? "-"} observations=${String(outcome.observations.observations.length)} artifacts=${String(outcome.artifacts.entries.length)}\n`,
  );
  const failure = outcome.internal_error;
  if (failure !== null) {
    process.stderr.write(`umami-driver: internal error in phase ${failure.phase} (${failure.error_class}${failure.code === null ? "" : ` ${failure.code}`}); records written\n`);
  }
  return exitCodeFor(outcome);
}

async function freeze(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      verifier: { type: "string" },
      out: { type: "string" },
      "base-url": { type: "string" },
      work: { type: "string" },
    },
  });
  const verifier = verifierPaths(resolve(values.verifier ?? KIT.verifierDir));
  const workDir = values.work === undefined ? mkdtempSync(join(tmpdir(), "rbw-freeze-")) : resolve(values.work);
  const result = await freezeSuite(
    {
      closureDir: verifier.suite,
      closureList: parseClosureList(await readFile(verifier.closureList, "utf8")),
      markerFile: verifier.marker,
      verifierNodeModules: verifier.nodeModules,
      verifierLockFile: verifier.lock,
      appDir: KIT.appDir,
      workDir,
      baseUrl: values["base-url"] ?? KIT_BASE_URL,
      nodePath: process.execPath,
      nodeVersion: process.version,
    },
    createProcessRunner(realTimers),
  );
  const out = resolve(values.out ?? verifier.manifest);
  writeFileSync(out, result.bytes, { mode: 0o600 });
  process.stdout.write(
    `original_suite_sha256=${result.sha256} tests=${String(result.manifest.test_count)} spec_files=${String(result.manifest.spec_files.length)} list_exit_code=${String(result.list_exit_code)} list_ran_global_setup=${String(result.list_ran_global_setup)}\n`,
  );
  return 0;
}

async function fetchClosureCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { list: { type: "string" }, verifier: { type: "string" } } });
  const list = resolve(required(values.list, "list"));
  const verifier = verifierPaths(resolve(required(values.verifier, "verifier")));
  const count = await fetchClosure(verifier.suite, (url) => fetch(url), parseClosureList(await readFile(list, "utf8")));
  await mkdir(dirname(verifier.closureList), { recursive: true });
  await copyFile(list, verifier.closureList);
  process.stdout.write(`fetch-closure: ${String(count)} files match the closure list\n`);
  return 0;
}

const KNOWN = [UsageError, RefusedInput, RecordError, FreezeError, ClosureFetchError];

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "run":
        return await run(rest);
      case "freeze":
        return await freeze(rest);
      case "fetch-closure":
        return await fetchClosureCommand(rest);
      default:
        throw new UsageError("usage: cli.ts run|freeze|fetch-closure [options]");
    }
  } catch (error) {
    const known = KNOWN.some((kind) => error instanceof kind) || (error instanceof TypeError && "code" in error);
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`umami-driver: ${known ? message : `internal error: ${message}`}\n`);
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
