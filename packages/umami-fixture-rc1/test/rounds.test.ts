import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { backupCodeFor, loadFixture, OBSERVATION_FIELDS, type DoubleSpendEvidence } from "../src/index.ts";
import { FakeApp, type RecordedCall } from "./fake-app.ts";

// Runs real Playwright rounds, exactly as the protected driver does (the staged
// playwright.config.ts and checks/rc1.check.ts), against FakeApp served on loopback.
const fixture = loadFixture();
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const playwrightCli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const CHECK_IDS = fixture.checks.map((check) => check.check_id);
const [, raceCheck] = fixture.checks;
if (raceCheck === undefined) {
  throw new Error("the fixture has two checks");
}
const RACE_ID = raceCheck.check_id;
const RACE_CODE = backupCodeFor(fixture, raceCheck).plaintext;
const SECRETS = ["synthetic-full-token", "synthetic-partial", "SYNTHETIC-RC1-CODE", "synthetic-password"];

/** Answers one request: delegate it to FakeApp, or drop the connection. */
type Handler = (call: RecordedCall) => Promise<{ status: number; body: Buffer }> | "drop";

interface Round {
  exitCode: number | null;
  calls: RecordedCall[];
  outputDir: string;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function serving(app: FakeApp): Handler {
  const context = app.context();
  return async (call) => {
    const response = await context.fetch(call.url, { method: call.method, headers: call.headers, data: call.data });
    return { status: response.status(), body: await response.body() };
  };
}

async function startServer(handler: Handler, calls: RecordedCall[]): Promise<string> {
  const server: Server = createServer((request, response) => {
    void readBody(request).then(async (data) => {
      const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, String(value)]));
      const call: RecordedCall = { url: request.url ?? "", method: request.method ?? "", headers, data };
      calls.push(call);
      const reply = handler(call);
      if (reply === "drop") {
        response.destroy();
        return;
      }
      const { status, body } = await reply;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function runRound(handler: Handler, prepare?: (outputDir: string) => void): Promise<Round> {
  const calls: RecordedCall[] = [];
  const baseUrl = await startServer(handler, calls);
  const outputDir = mkdtempSync(join(tmpdir(), "rbw-umami-fixture-rc1-round-"));
  cleanups.push(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });
  prepare?.(outputDir);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    RBW_FIXTURE_BASE_URL: baseUrl,
    RBW_FIXTURE_REPEAT_INDEX: "7",
    RBW_FIXTURE_OUTPUT_DIR: outputDir,
    RBW_FIXTURE_ADMIN_USERNAME: "synthetic-admin",
    RBW_FIXTURE_ADMIN_PASSWORD: "synthetic-password",
  };
  const child = spawn(process.execPath, [playwrightCli, "test", "--config", "playwright.config.ts", "--workers=1", "--retries=0"], {
    cwd: packageDir,
    env,
    stdio: "ignore",
  });
  const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { exitCode, calls, outputDir };
}

function observation(round: Round, checkId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(round.outputDir, "observations", `${checkId}.json`), "utf8")) as Record<string, unknown>;
}

function outcomes(round: Round): string[] {
  return CHECK_IDS.map((id) => {
    const row = observation(round, id);
    return `${String(row.observed)}:${String(row.failure_code)}`;
  });
}

function paths(round: Round): string[] {
  return round.calls.map((call) => call.url);
}

function raceEvidence(round: Round): DoubleSpendEvidence {
  return JSON.parse(readFileSync(join(round.outputDir, "responses", `${RACE_ID}.json`), "utf8")) as DoubleSpendEvidence;
}

function reportStats(round: Round): unknown {
  return (JSON.parse(readFileSync(join(round.outputDir, "report.json"), "utf8")) as { stats: unknown }).stats;
}

function assertOutputContract(round: Round): void {
  for (const id of CHECK_IDS) {
    const row = observation(round, id);
    expect(Object.keys(row)).toEqual([...OBSERVATION_FIELDS]);
    expect(row.repeat_index).toBe(7);
    expect(Number.isInteger(row.duration_ms)).toBe(true);
    expect(row.response_artifact_key === null).toBe(row.response_artifact_sha256 === null);
    if (typeof row.response_artifact_key === "string") {
      expect(row.response_artifact_key).toBe(`responses/${id}.json`);
      const saved = readFileSync(join(round.outputDir, row.response_artifact_key));
      expect(row.response_artifact_sha256).toBe(createHash("sha256").update(saved).digest("hex"));
    }
  }
  expect(existsSync(join(round.outputDir, "report.json"))).toBe(true);
  for (const file of readdirSync(round.outputDir, { recursive: true, encoding: "utf8" })) {
    const path = join(round.outputDir, file);
    if (!statSync(path).isDirectory()) {
      const text = readFileSync(path, "utf8");
      for (const secret of SECRETS) {
        expect(text, file).not.toContain(secret);
      }
    }
  }
}

describe("a Playwright round of the staged checks against a fake Umami", () => {
  it("passes both checks on the clean route, with overlap evidence for the race", async () => {
    const round = await runRound(serving(new FakeApp(fixture, "clean", { pairReadsOf: RACE_CODE })));
    expect(round.exitCode).toBe(0);
    expect(outcomes(round)).toEqual(["pass:null", "pass:null"]);
    expect(paths(round)).toEqual(["/api/auth/login", "/api/2fa/verify", "/api/auth/login", "/api/2fa/verify", "/api/auth/login", "/api/auth/login", "/api/2fa/verify", "/api/2fa/verify"]);
    const evidence = raceEvidence(round);
    expect(evidence).toMatchObject({ check_id: RACE_ID, kind: "concurrent_double_spend" });
    expect(evidence.overlap_ms).toBeGreaterThan(0);
    expect(evidence.attempts.map((attempt) => attempt.token_issued).sort()).toEqual([false, true]);
    expect(reportStats(round)).toMatchObject({ expected: 2, unexpected: 0 });
    assertOutputContract(round);
  });

  it("fails the race with double_spend on the planted route while the serial control passes", async () => {
    const round = await runRound(serving(new FakeApp(fixture, "planted", { pairReadsOf: RACE_CODE })));
    expect(round.exitCode).toBe(1);
    expect(outcomes(round)).toEqual(["pass:null", "assertion_fail:double_spend"]);
    const evidence = raceEvidence(round);
    expect(evidence.overlap_ms).toBeGreaterThan(0);
    expect(evidence.attempts.map((attempt) => attempt.token_issued)).toEqual([true, true]);
    expect(reportStats(round)).toMatchObject({ expected: 1, unexpected: 1 });
    assertOutputContract(round);
  });

  it("records seed_failed with no response file when sign-in returns no two-factor challenge", async () => {
    const app = new FakeApp(fixture, "clean");
    app.twoFactorEnabled = false;
    const round = await runRound(serving(app));
    expect(round.exitCode).toBe(1);
    expect(outcomes(round)).toEqual(["setup_fail:seed_failed", "setup_fail:seed_failed"]);
    expect(paths(round)).toEqual(["/api/auth/login", "/api/auth/login"]);
    for (const id of CHECK_IDS) {
      expect(observation(round, id)).toMatchObject({ response_artifact_key: null, response_artifact_sha256: null });
    }
    expect(readdirSync(round.outputDir)).not.toContain("responses");
    assertOutputContract(round);
  });

  it("records auth_failed for both checks when the sign-in connection drops", async () => {
    const round = await runRound(() => "drop");
    expect(round.exitCode).toBe(1);
    expect(outcomes(round)).toEqual(["setup_fail:auth_failed", "setup_fail:auth_failed"]);
    expect(readdirSync(round.outputDir)).not.toContain("responses");
    assertOutputContract(round);
  });

  it("refuses an output directory that is not empty, sending nothing and overwriting nothing", async () => {
    const round = await runRound(serving(new FakeApp(fixture, "clean")), (outputDir) => {
      writeFileSync(join(outputDir, "report.json"), "synthetic earlier report");
    });
    expect(readFileSync(join(round.outputDir, "report.json"), "utf8")).toBe("synthetic earlier report");
    expect(round.exitCode).not.toBe(0);
    expect(round.calls).toHaveLength(0);
    expect(existsSync(join(round.outputDir, "observations"))).toBe(false);
    expect(readdirSync(round.outputDir)).not.toContain("responses");
  });
});
