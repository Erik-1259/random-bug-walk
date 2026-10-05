import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureReport } from "../src/fixtures.ts";
import { fixturesDir, packageDir } from "./support.ts";

const repositoryRoot = join(packageDir, "..", "..");

describe("report commands", () => {
  it("prints the TypeScript report", () => {
    const result = spawnSync(process.execPath, [join(packageDir, "scripts", "report.ts"), fixturesDir], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(fixtureReport(fixturesDir).map((line) => `${line}\n`).join(""));
  });

  it("matches the Python report line for line", () => {
    const typescript = spawnSync(process.execPath, [join(packageDir, "scripts", "report.ts"), fixturesDir], { encoding: "utf8" });
    const python = spawnSync("uv", ["run", "--frozen", "python", "-m", "rbw_schema.report", fixturesDir], { cwd: repositoryRoot, encoding: "utf8" });
    expect(python.status).toBe(0);
    expect(python.stdout).toBe(typescript.stdout);
  });
});
