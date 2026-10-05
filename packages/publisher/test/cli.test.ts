import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess, type ProcessRunner } from "../src/process.ts";
import { runCli } from "../src/cli.ts";
import { isInside } from "../src/config.ts";
import {
  BASE_URI,
  FORBIDDEN_TERM,
  OTHER_ROOT_ID,
  PROJECT_ID,
  REPOSITORY_URL,
  ROOT_ID,
  createWorld,
  expectNotPublished,
  packageDir,
  publishArgv,
  publish,
  sha256,
  stage,
  statusObject,
  tempDir,
  write,
  writeFakeScanner,
  writeRootRun,
} from "./support.ts";

const cliPath = join(packageDir, "src", "cli.ts");

describe("policy command", () => {
  const args = (out: string, version = "1"): string[] => [
    "policy",
    "--project-id",
    PROJECT_ID,
    "--output-repository",
    REPOSITORY_URL,
    "--artifact-base-uri",
    BASE_URI,
    "--policy-version",
    version,
    "--out",
    out,
  ];

  it("writes the canonical policy and prints its hash", async () => {
    const world = createWorld();
    const out = join(world.dir, "frozen", "policy.json");
    const result = await runCli(args(out), { env: {} });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${sha256(readFileSync(out))}\n`);
    expect(readFileSync(out).equals(readFileSync(world.policyFile))).toBe(true);
    // Writing the same policy again is a no-op that prints the same hash.
    expect(await runCli(args(out), { env: {} })).toMatchObject({ code: 0, stdout: result.stdout });
  });

  it("refuses to overwrite a different policy file", async () => {
    const world = createWorld();
    const out = join(world.dir, "frozen", "policy.json");
    expect((await runCli(args(out), { env: {} })).code).toBe(0);
    const before = readFileSync(out);
    const result = await runCli(args(out, "2"), { env: {} });
    expect(result.code).toBe(4);
    expect(readFileSync(out).equals(before)).toBe(true);
  });

  it("refuses invalid values", async () => {
    const world = createWorld();
    const out = join(world.dir, "frozen", "policy.json");
    const result = await runCli(args(out).map((arg) => (arg === REPOSITORY_URL ? `${REPOSITORY_URL}.git` : arg)), { env: {} });
    expect(result.code).toBe(4);
    expect(existsSync(out)).toBe(false);
  });
});

describe("status command", () => {
  it("reports each root's publication status and the count per status", async () => {
    const world = createWorld();
    stage(world.staging);
    expect((await publish(world, writeRootRun(world))).code).toBe(0);
    const otherStaging = join(world.dir, "staging-other");
    stage(otherStaging, { extra: { "inputs/notes.md": `${FORBIDDEN_TERM}\n` } });
    const blocked = await publish(world, writeRootRun(world, { root: OTHER_ROOT_ID, name: "other" }), ["--staging", otherStaging]);
    expect(blocked.code).toBe(1);
    const result = await runCli(["status", "--state", world.state], { env: {} });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        `root ${ROOT_ID} published`,
        `root ${OTHER_ROOT_ID} blocked`,
        "count prepared 0",
        "count published 1",
        "count blocked 1",
        "count failed 0",
        "",
      ].join("\n"),
    );
  });
});

describe("command line", () => {
  it("runs under Node directly and maps outcomes to exit codes", () => {
    const world = createWorld();
    stage(world.staging);
    const env = { PATH: process.env.PATH ?? "", HOME: world.dir };
    const published = spawnSync(process.execPath, [cliPath, ...publishArgv(world, writeRootRun(world))], { env, encoding: "utf8" });
    expect(published.status).toBe(0);
    expect(JSON.parse(published.stdout)).toMatchObject({ status: "published" });
    const running = spawnSync(process.execPath, [cliPath, ...publishArgv(world, writeRootRun(world, { root: OTHER_ROOT_ID, status: "running", name: "running" }))], {
      env,
      encoding: "utf8",
    });
    expect(running.status).toBe(3);
    const invalid = spawnSync(process.execPath, [cliPath, "publish", "--policy", world.policyFile], { env, encoding: "utf8" });
    expect(invalid.status).toBe(4);
    expect(spawnSync(process.execPath, [cliPath, "unknown"], { env, encoding: "utf8" }).status).toBe(4);
  });
});

describe("never shown as published", () => {
  it("keeps every failure path away from published", async () => {
    const world = createWorld();
    stage(world.staging, { extra: { "inputs/notes.md": `${FORBIDDEN_TERM}\n` } });
    const rootRun = writeRootRun(world);
    expectNotPublished(await publish(world, rootRun), world);

    const second = createWorld();
    stage(second.staging);
    const secondRoot = writeRootRun(second);
    expectNotPublished(await publish(second, secondRoot, ["--scanner", writeFakeScanner(second.dir, "exit7")]), second);
    const rejecting: ProcessRunner = async (call) =>
      call.command === "git" && call.args.includes("push")
        ? { code: 128, spawnFailed: false, timedOut: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
        : runProcess(call);
    const rejected = await publish(second, secondRoot, [], { runner: rejecting });
    expectNotPublished(rejected, second);
    expect(statusObject(second)?.publication_status).toBe("failed");

    const third = createWorld();
    stage(third.staging);
    write(join(third.store, "sha256", sha256(readFileSync(join(third.staging, "results", "00000000-0000-4000-8000-000000000201", "planted-01", "big.bin")))), "wrong");
    expectNotPublished(await publish(third, writeRootRun(third)), third);

    const fourth = createWorld();
    stage(fourth.staging);
    writeFileSync(fourth.policyFile, `${readFileSync(fourth.policyFile, "utf8")} `);
    expectNotPublished(await publish(fourth, writeRootRun(fourth)), fourth);
  });
});

describe("location checks", () => {
  it("compares directory identities, not spellings", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "alias"));
    expect(isInside(join(dir, "alias", "state"), join(dir, "real"))).toBe(true);
    expect(isInside(join(dir, "alias"), join(dir, "real"))).toBe(true);
    expect(isInside(join(dir, "other"), join(dir, "real"))).toBe(false);
    expect(isInside(join(dir, "real"), join(dir, "real", "inner"))).toBe(false);
  });
});
