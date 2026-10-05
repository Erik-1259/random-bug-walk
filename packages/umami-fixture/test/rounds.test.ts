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
import { loadFixture, OBSERVATION_FIELDS } from "../src/index.ts";
import { healthyReply, type RecordedCall, type Reply } from "./helpers.ts";

// Runs real Playwright rounds, exactly as the protected driver does, against a local fake of the
// Umami API on loopback.
const fixture = loadFixture();
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const playwrightCli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const CHECK_IDS = fixture.checks.map((check) => check.check_id);

interface Round {
  exitCode: number | null;
  calls: RecordedCall[];
  outputDir: string;
  sentBodies: Map<string, Buffer>;
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

async function startServer(handler: (call: RecordedCall, calls: RecordedCall[]) => Reply, calls: RecordedCall[], sentBodies: Map<string, Buffer>): Promise<string> {
  const server: Server = createServer((request, response) => {
    void readBody(request).then((data) => {
      const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, String(value)]));
      const call: RecordedCall = { url: request.url ?? "", method: request.method ?? "", headers, data };
      calls.push(call);
      const reply = handler(call, calls);
      if (reply instanceof Error) {
        response.destroy();
        return;
      }
      const bytes = Buffer.from(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
      const timezone = new URL(call.url, "http://fixture.invalid").searchParams.get("timezone");
      if (timezone !== null) {
        sentBodies.set(timezone, bytes);
      }
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(bytes);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function runRound(handler: (call: RecordedCall, calls: RecordedCall[]) => Reply, prepare?: (outputDir: string) => void): Promise<Round> {
  const calls: RecordedCall[] = [];
  const sentBodies = new Map<string, Buffer>();
  const baseUrl = await startServer(handler, calls, sentBodies);
  const outputDir = mkdtempSync(join(tmpdir(), "rbw-umami-fixture-round-"));
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
  return { exitCode, calls, outputDir, sentBodies };
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

function count(round: Round, path: string): number {
  return round.calls.filter((call) => new URL(call.url, "http://fixture.invalid").pathname === path).length;
}

function plantedReply(call: RecordedCall): Reply {
  const url = new URL(call.url, "http://fixture.invalid");
  if (url.pathname === fixture.request.path) {
    const points = fixture.bucket_labels.map((x, index) => ({ x, y: fixture.checks[0]?.expected[index] }));
    return { status: 200, body: { pageviews: points, sessions: points } };
  }
  return healthyReply(call);
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
      const timezone = fixture.checks.find((check) => check.check_id === id)?.timezone ?? "";
      expect(saved.equals(round.sentBodies.get(timezone) ?? Buffer.alloc(0))).toBe(true);
    }
  }
  expect(existsSync(join(round.outputDir, "report.json"))).toBe(true);
  for (const file of readdirSync(round.outputDir, { recursive: true, encoding: "utf8" })) {
    const path = join(round.outputDir, file);
    if (!statSync(path).isDirectory()) {
      expect(readFileSync(path, "utf8"), file).not.toContain("synthetic-token");
    }
  }
}

describe("a Playwright round against a fake Umami", () => {
  it("passes all four checks on a healthy install, querying UTC first", async () => {
    const round = await runRound(healthyReply);
    expect(round.exitCode).toBe(0);
    expect(outcomes(round)).toEqual(["pass:null", "pass:null", "pass:null", "pass:null"]);
    expect(round.calls.filter((call) => call.url.startsWith(fixture.request.path)).map((call) => new URL(call.url, "http://fixture.invalid").searchParams.get("timezone"))).toEqual(
      fixture.checks.map((check) => check.timezone),
    );
    expect(count(round, "/api/send")).toBe(12);
    expect(count(round, "/api/websites")).toBe(1);
    assertOutputContract(round);
  });

  it("still executes the other three checks when the Los Angeles query fails, without resending", async () => {
    const round = await runRound((call) => (call.url.includes("America%2FLos_Angeles") ? { status: 500, body: { error: "synthetic" } } : healthyReply(call)));
    expect(round.exitCode).toBe(1);
    expect(outcomes(round)).toEqual(["pass:null", "setup_fail:unrelated_failure", "pass:null", "pass:null"]);
    expect(count(round, "/api/send")).toBe(12);
    expect(count(round, "/api/websites")).toBe(1);
    assertOutputContract(round);
  });

  it("still executes the other three checks when the Los Angeles connection drops", async () => {
    const round = await runRound((call) => (call.url.includes("America%2FLos_Angeles") ? new Error("synthetic drop") : healthyReply(call)));
    expect(round.exitCode).toBe(1);
    expect(outcomes(round)).toEqual(["pass:null", "setup_fail:unrelated_failure", "pass:null", "pass:null"]);
    expect(observation(round, "tzarg.la-day-counts").response_artifact_key).toBeNull();
    assertOutputContract(round);
  });

  it("fails each non-UTC check at its own assertion when buckets ignore the zone", async () => {
    const round = await runRound(plantedReply);
    expect(round.exitCode).toBe(1);
    expect(outcomes(round)).toEqual([
      "pass:null",
      "assertion_fail:local_day_counts_mismatch",
      "assertion_fail:local_day_counts_mismatch",
      "assertion_fail:local_day_counts_mismatch",
    ]);
    expect(count(round, "/api/send")).toBe(12);
    const report = JSON.parse(readFileSync(join(round.outputDir, "report.json"), "utf8")) as { stats: { expected: number; unexpected: number } };
    expect(report.stats).toMatchObject({ expected: 1, unexpected: 3 });
    assertOutputContract(round);
  });

  it("marks all four checks seed_failed when a send fails, and makes no query", async () => {
    let sends = 0;
    const round = await runRound((call) => {
      if (call.url === "/api/send") {
        sends += 1;
        if (sends === 3) {
          return { status: 500, body: { error: "synthetic" } };
        }
      }
      return healthyReply(call);
    });
    expect(round.exitCode).toBe(1);
    expect(outcomes(round)).toEqual(Array.from({ length: 4 }, () => "setup_fail:seed_failed"));
    expect(count(round, "/api/send")).toBe(3);
    expect(count(round, fixture.request.path)).toBe(0);
    assertOutputContract(round);
  });

  it("marks all four checks auth_failed when login fails", async () => {
    const round = await runRound((call) => (call.url === "/api/auth/login" ? { status: 401, body: { error: "synthetic" } } : healthyReply(call)));
    expect(round.exitCode).toBe(1);
    expect(outcomes(round)).toEqual(Array.from({ length: 4 }, () => "setup_fail:auth_failed"));
    expect(count(round, "/api/send")).toBe(0);
    assertOutputContract(round);
  });

  it("refuses an output directory that is not empty, sending nothing and overwriting nothing", async () => {
    const round = await runRound(healthyReply, (outputDir) => {
      writeFileSync(join(outputDir, "report.json"), "synthetic earlier report");
    });
    expect(readFileSync(join(round.outputDir, "report.json"), "utf8")).toBe("synthetic earlier report");
    expect(round.exitCode).not.toBe(0);
    expect(round.calls).toHaveLength(0);
    expect(existsSync(join(round.outputDir, "observations"))).toBe(false);
    expect(readdirSync(round.outputDir)).not.toContain("responses");
  });
});
