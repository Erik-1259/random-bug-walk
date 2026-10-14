// The command line: the dry-run pilot end to end in a child process, and the exit codes for a
// usage error and a missing environment variable. No live call is made.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "DATABASE_URL" && name !== "TOKEN_FACTORY_SOLVER_KEY"));
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...clean, ...env }, timeout: 120_000 });
}

describe("the uc1 command line", () => {
  it("runs the whole pilot in the dry-run world: sessions, grade 2 and finalize, with no live call", () => {
    const work = mkdtempSync(join(tmpdir(), "rbw-uc1-cli-"));
    const result = cli(["dry-run", "--work", work]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("sessions_exit=0 grade2_exit=0 finalize_exit=0 model_requests=18");
    expect(existsSync(join(work, "runs", "dry-run-pilot", "staging", "report.md"))).toBe(true);
  });

  it("exits 2 with the usage on an unknown command or option", () => {
    const unknown = cli(["publish"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("unknown command publish");
    expect(unknown.stderr).toContain("usage:");
    expect(cli(["grade2", "--bogus", "x"]).status).toBe(2);
  });

  it("exits 2 before anything starts when DATABASE_URL is not set", () => {
    const result = cli(["pilot", "--runs-dir", "runs", "--name", "pilot-01", "--case", "case.json", "--policy", "policy.json"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("uc1: DATABASE_URL is not set\n");
  });

  it("exits 2 when the solver key is not set for a step that calls the model", () => {
    const result = cli(["pilot", "--runs-dir", "runs", "--name", "pilot-01", "--case", "case.json", "--policy", "policy.json"], { DATABASE_URL: "postgres://synthetic.invalid/db" });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("uc1: TOKEN_FACTORY_SOLVER_KEY is not set\n");
  });
});
