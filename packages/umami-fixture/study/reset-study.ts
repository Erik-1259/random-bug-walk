// Runs the reset study for fixture umami-tz-arg-001 against a running clean stack whose Postgres
// port is published (host/compose.db-port.yml). Each step appends one JSON line per round to
// <out>/results.jsonl; "summarize" writes a per-round summary with byte comparisons against the
// reference round, the input to the committed evidence file.
//
//   node study/reset-study.ts prepare   --database-url <url>
//   node study/reset-study.ts round     --base-url <url> --out <dir> --label <label>
//   node study/reset-study.ts suite     --base-url <url> --out <dir> --suite-dir <umami copy>
//   node study/reset-study.ts candidate --base-url <url> --database-url <url> --out <dir> --label <label> --method <in-place|template> --rounds <n>
//   node study/reset-study.ts summarize --out <dir> --reference <label> --evidence <file>
//
// The database URL is the disposable test stack's synthetic login; it is never written out.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadFixture, type Observation } from "../src/index.ts";
import { createFixtureTemplate, resetFixture } from "../src/reset.ts";
import { resetInPlace, snapshotTables } from "./in-place.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const fixture = loadFixture();

interface RoundRecord {
  label: string;
  round: number;
  exit_code: number | null;
  reset_ms: number | null;
  round_ms: number;
  outcomes: { check_id: string; observed: string; failure_code: string | null; counts: number[] | null; response_sha256: string | null }[];
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function counts(body: Buffer): number[] | null {
  const parsed = JSON.parse(body.toString("utf8")) as { pageviews?: { y: unknown }[] };
  return Array.isArray(parsed.pageviews) ? parsed.pageviews.map((point) => Number(point.y)) : null;
}

function runRound(baseUrl: string, outputDir: string, index: number): { exitCode: number | null; ms: number; outcomes: RoundRecord["outcomes"] } {
  mkdirSync(outputDir, { recursive: true });
  const cli = createRequire(join(packageDir, "package.json")).resolve("@playwright/test/cli");
  const started = performance.now();
  const result = spawnSync(process.execPath, [cli, "test", "--config", join(packageDir, "playwright.config.ts"), "--workers=1", "--retries=0"], {
    env: { ...process.env, RBW_FIXTURE_BASE_URL: baseUrl, RBW_FIXTURE_REPEAT_INDEX: String(index), RBW_FIXTURE_OUTPUT_DIR: outputDir },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const ms = Math.round(performance.now() - started);
  const outcomes = fixture.checks.map((check) => {
    const file = join(outputDir, "observations", `${check.check_id}.json`);
    if (!existsSync(file)) {
      return { check_id: check.check_id, observed: "not_run", failure_code: null, counts: null, response_sha256: null };
    }
    const observation = JSON.parse(readFileSync(file, "utf8")) as Observation;
    const body = observation.response_artifact_key === null ? null : readFileSync(join(outputDir, observation.response_artifact_key));
    return {
      check_id: check.check_id,
      observed: observation.observed,
      failure_code: observation.failure_code,
      counts: body === null ? null : counts(body),
      response_sha256: observation.response_artifact_sha256,
    };
  });
  return { exitCode: result.status, ms, outcomes };
}

interface SuiteNode {
  suites?: SuiteNode[];
  specs?: { file: string; title: string; ok: boolean }[];
}

/** Every test in a Playwright JSON report, with its file and whether it passed. */
function suiteSpecs(node: SuiteNode): { file: string; title: string; ok: boolean }[] {
  return [...(node.specs ?? []), ...(node.suites ?? []).flatMap(suiteSpecs)];
}

function record(out: string, entry: RoundRecord | Record<string, unknown>): void {
  mkdirSync(out, { recursive: true });
  appendFileSync(join(out, "results.jsonl"), `${JSON.stringify(entry)}\n`);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function nextRoundIndex(out: string, label: string): number {
  const dir = join(out, label);
  return existsSync(dir) ? readdirSync(dir).length + 1 : 1;
}

function summarize(out: string, reference: string, evidence: string): void {
  const lines = readFileSync(join(out, "results.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const rounds = lines.filter((line) => "round" in line) as unknown as RoundRecord[];
  const referenceRound = rounds.find((round) => round.label === reference);
  if (referenceRound === undefined) {
    throw new Error(`no round labelled ${reference}`);
  }
  const referenceBodies = new Map(
    fixture.checks.map((check) => [check.check_id, readFileSync(join(out, reference, `round-${String(referenceRound.round)}`, "responses", `${check.check_id}.json`))]),
  );
  const compared = rounds.map((round) => ({
    ...round,
    bodies_identical_to_reference: fixture.checks.every((check) => {
      const file = join(out, round.label, `round-${String(round.round)}`, "responses", `${check.check_id}.json`);
      return existsSync(file) && readFileSync(file).equals(referenceBodies.get(check.check_id) ?? Buffer.alloc(0));
    }),
  }));
  const sha = (body: Buffer): string => createHash("sha256").update(body).digest("hex");
  writeFileSync(
    resolve(evidence),
    `${JSON.stringify(
      {
        reference: { label: reference, response_sha256: Object.fromEntries([...referenceBodies].map(([id, body]) => [id, sha(body)])) },
        steps: lines.filter((line) => !("round" in line)),
        rounds: compared,
      },
      null,
      2,
    )}\n`,
  );
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "base-url": { type: "string" },
      "database-url": { type: "string" },
      out: { type: "string" },
      label: { type: "string" },
      method: { type: "string" },
      rounds: { type: "string" },
      "suite-dir": { type: "string" },
      reference: { type: "string" },
      evidence: { type: "string" },
    },
  });
  const command = positionals[0];
  if (command === "prepare") {
    const databaseUrl = required(values["database-url"], "database-url");
    const started = performance.now();
    await createFixtureTemplate(databaseUrl);
    const tables = await snapshotTables(databaseUrl);
    process.stdout.write(`prepared the template database and a snapshot of ${String(tables)} tables in ${String(Math.round(performance.now() - started))} ms\n`);
    return;
  }
  const out = resolve(required(values.out, "out"));
  if (command === "summarize") {
    summarize(out, required(values.reference, "reference"), required(values.evidence, "evidence"));
    return;
  }
  const baseUrl = required(values["base-url"], "base-url");
  if (command === "round") {
    const label = required(values.label, "label");
    const index = nextRoundIndex(out, label);
    const result = runRound(baseUrl, join(out, label, `round-${String(index)}`), index);
    record(out, { label, round: index, exit_code: result.exitCode, reset_ms: null, round_ms: result.ms, outcomes: result.outcomes });
    return;
  }
  if (command === "suite") {
    const suiteDir = resolve(required(values["suite-dir"], "suite-dir"));
    const cli = createRequire(join(suiteDir, "package.json")).resolve("@playwright/test/cli");
    const report = join(out, `suite-${String(Date.now())}.json`);
    const started = performance.now();
    const result = spawnSync(process.execPath, [cli, "test", "-c", "playwright.api.config.ts", "--reporter=json"], {
      cwd: suiteDir,
      env: { ...process.env, PLAYWRIGHT_BASE_URL: baseUrl, API_ALLOW_DESTRUCTIVE: "1", PLAYWRIGHT_JSON_OUTPUT_NAME: report },
      stdio: ["ignore", "ignore", "inherit"],
    });
    const ms = Math.round(performance.now() - started);
    const specs = suiteSpecs(JSON.parse(readFileSync(report, "utf8")) as SuiteNode);
    const failed = specs.filter((spec) => !spec.ok).map((spec) => `${spec.file} › ${spec.title}`);
    record(out, { step: "original-suite", exit_code: result.status, ms, passed: specs.length - failed.length, failed });
    return;
  }
  if (command === "candidate") {
    const databaseUrl = required(values["database-url"], "database-url");
    const label = required(values.label, "label");
    const method = required(values.method, "method");
    const reset = method === "in-place" ? resetInPlace : method === "template" ? resetFixture : undefined;
    if (reset === undefined) {
      throw new Error("--method must be in-place or template");
    }
    const rounds = Number(required(values.rounds, "rounds"));
    for (let i = 0; i < rounds; i += 1) {
      const index = nextRoundIndex(out, label);
      const started = performance.now();
      await reset(databaseUrl);
      const resetMs = Math.round(performance.now() - started);
      const result = runRound(baseUrl, join(out, label, `round-${String(index)}`), index);
      record(out, { label, round: index, exit_code: result.exitCode, reset_ms: resetMs, round_ms: result.ms, outcomes: result.outcomes });
    }
    return;
  }
  throw new Error(`unknown command ${String(command)}`);
}

await main();
