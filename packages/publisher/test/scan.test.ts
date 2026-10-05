import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BIG_FILE,
  CHILD_ID,
  allBytes,
  FORBIDDEN_TERM,
  commitCount,
  createWorld,
  expectNotPublished,
  listFiles,
  printed,
  publish,
  readPublished,
  scannerCli,
  stage,
  statusObject,
  storeObjects,
  write,
  writeFakeScanner,
  writeRootRun,
  type World,
} from "./support.ts";

function expectNothingPublished(world: World): void {
  expect(commitCount(world.remote)).toBe(0);
  expect(storeObjects(world.store)).toEqual([]);
}

describe("forbidden terms", () => {
  const cases: [string, (world: World) => void, RegExp][] = [
    [
      "a repository file",
      (world) => { stage(world.staging, { extra: { "inputs/notes.md": `line one\nmentions ${FORBIDDEN_TERM} here\n` } }); },
      /^runs\/[0-9a-f-]+\/inputs\/notes\.md:2$/,
    ],
    [
      "a large file",
      (world) => { stage(world.staging, { big: Buffer.from(`${"x".repeat(2000)}\n${FORBIDDEN_TERM}\n`) }); },
      new RegExp(`^runs/[0-9a-f-]+/${BIG_FILE.replace(/[/.]/g, "\\$&")}:2$`),
    ],
    [
      "a file name",
      (world) => { stage(world.staging, { extra: { [`logs/${FORBIDDEN_TERM}.log`]: "plain content\n" } }); },
      // The name is listed in the path list and inside the manifest.
      /^(?:paths:\d+|runs\/[0-9a-f-]+\/manifest\.json:1)$/,
    ],
  ];

  for (const [label, arrange, location] of cases) {
    it(`blocks ${label} and prints only path:line`, async () => {
      const world = createWorld();
      arrange(world);
      const result = await publish(world, writeRootRun(world));
      expect(result.code).toBe(1);
      const record = printed(result);
      expect(record).toMatchObject({ status: "blocked", failure_reason: "scan_blocked", repository_commit: null, artifacts: [] });
      const locations = result.stderr.split("\n").filter((line) => /:\d+$/.test(line) && !line.includes("="));
      expect(locations.length).toBeGreaterThan(0);
      for (const line of locations) expect(line).toMatch(location);
      expect(result.stdout + result.stderr).not.toContain(FORBIDDEN_TERM);
      expectNothingPublished(world);
      expectNotPublished(result, world);
      expect(statusObject(world)?.publication_status).toBe("blocked");
    });
  }

  it("publishes explicit replacement bytes under a new publication ID", async () => {
    const world = createWorld();
    stage(world.staging, { extra: { "inputs/notes.md": `mentions ${FORBIDDEN_TERM}\n` } });
    const rootRun = writeRootRun(world);
    const blocked = printed(await publish(world, rootRun));
    expect(blocked.status).toBe("blocked");

    writeFileSync(join(world.staging, "inputs", "notes.md"), "clean replacement\n");
    // Without the option the frozen candidate is retried as is.
    const retried = await publish(world, rootRun);
    expect(printed(retried)).toMatchObject({ status: "blocked", publication_id: blocked.publication_id });

    const replaced = await publish(world, rootRun, ["--replace"]);
    expect(replaced.code).toBe(0);
    const record = printed(replaced);
    expect(record.status).toBe("published");
    expect(record.publication_id).not.toBe(blocked.publication_id);
    expect(readPublished(world).files.get("inputs/notes.md")?.toString("utf8")).toBe("clean replacement\n");

    // A published candidate cannot be replaced.
    const again = await publish(world, rootRun, ["--replace"]);
    expect(again.code).toBe(4);
    expect(commitCount(world.remote)).toBe(1);
  });

  describe("a retry with a changed terminal snapshot", () => {
    const OTHER_CHILD = "00000000-0000-4000-8000-000000000202";
    const changes: [string, Parameters<typeof writeRootRun>[1]][] = [
      ["outcome", { outcome: "failed", name: "changed" }],
      ["child count", { children: [CHILD_ID, OTHER_CHILD], name: "changed" }],
    ];

    for (const [label, change] of changes) {
      it(`is refused when the ${label} differs, and writes nothing`, async () => {
        const world = createWorld();
        stage(world.staging, { extra: { "inputs/notes.md": `mentions ${FORBIDDEN_TERM}\n` } });
        expect(printed(await publish(world, writeRootRun(world))).status).toBe("blocked");
        const statusBefore = statusObject(world);
        const stateFiles = listFiles(world.state);
        const stateBytes = allBytes(world.state);

        const retry = await publish(world, writeRootRun(world, change));
        expect(retry.code).toBe(4);
        expect(retry.stdout).toBe("");
        expect(retry.stderr).toContain("root_run_changed");
        expect(statusObject(world)).toEqual(statusBefore);
        expect(listFiles(world.state)).toEqual(stateFiles);
        expect(allBytes(world.state).equals(stateBytes)).toBe(true);
        expectNothingPublished(world);
      });
    }

    it("still resumes when the snapshot is identical", async () => {
      const world = createWorld();
      stage(world.staging, { extra: { "inputs/notes.md": `mentions ${FORBIDDEN_TERM}\n` } });
      const rootRun = writeRootRun(world);
      const blocked = printed(await publish(world, rootRun));
      const retry = await publish(world, rootRun);
      expect(printed(retry)).toMatchObject({ status: "blocked", publication_id: blocked.publication_id });
    });
  });

  it("refuses a replacement while the candidate is not blocked", async () => {
    const world = createWorld();
    stage(world.staging);
    const rootRun = writeRootRun(world);
    const failed = await publish(world, rootRun, ["--patterns", join(world.dir, "missing.txt")]);
    expect(printed(failed).status).toBe("failed");
    const replaced = await publish(world, rootRun, ["--replace"]);
    expect(replaced.code).toBe(4);
    expectNothingPublished(world);
  });

  it("scans the sanitized bytes, so a redacted value does not block", async () => {
    const world = createWorld();
    write(world.patterns, `${["synthetic", "listed", "value", "one"].join("-")}\n`);
    stage(world.staging);
    const result = await publish(world, writeRootRun(world));
    expect(result.code).toBe(0);
  });
});

describe("scanner unavailable", () => {
  const cases: [string, (world: World) => string[]][] = [
    ["a missing pattern file", (world) => ["--patterns", join(world.dir, "private", "absent.txt")]],
    [
      "an empty pattern file",
      (world) => {
        write(join(world.dir, "private", "empty.txt"), "# only a comment\n\n");
        return ["--patterns", join(world.dir, "private", "empty.txt")];
      },
    ],
    ["exit status 2", (world) => ["--scanner", writeFakeScanner(world.dir, "exit2")]],
    ["an unknown exit status", (world) => ["--scanner", writeFakeScanner(world.dir, "exit7")]],
    ["an exit status that disagrees with the output", (world) => ["--scanner", writeFakeScanner(world.dir, "lie")]],
    ["a crash", (world) => ["--scanner", writeFakeScanner(world.dir, "signal")]],
    ["a timeout", (world) => ["--scanner", writeFakeScanner(world.dir, "sleep"), "--scan-timeout-ms", "1500"]],
    ["a scanner that cannot start", (world) => ["--scanner", join(world.dir, "no-such-scanner")]],
    ["a gitleaks that cannot run", (world) => ["--gitleaks", join(world.dir, "no-such-gitleaks")]],
  ];

  for (const [label, extra] of cases) {
    it(`records failed (scan_unavailable) for ${label}`, async () => {
      const world = createWorld();
      stage(world.staging);
      const result = await publish(world, writeRootRun(world), extra(world));
      expect(result.code).toBe(2);
      expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "scan_unavailable", repository_commit: null });
      expectNothingPublished(world);
      expectNotPublished(result, world);
    });
  }

  it("never lets the scanner see the credential variables", async () => {
    const world = createWorld();
    stage(world.staging);
    const envDump = join(world.dir, "scanner-env.json");
    const script = write(
      join(world.dir, "env-scanner.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(envDump)}, JSON.stringify(Object.keys(process.env)));\nprocess.stdout.write("clean\\n");\n`,
    );
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: world.dir,
      RBW_RESULTS_DEPLOY_KEY_FILE: join(world.dir, "unused-key"),
      RBW_PUBLIC_STORE_TOKEN: ["synthetic", "placeholder"].join("-"),
    };
    const result = await publish(world, writeRootRun(world), ["--scanner", `${process.execPath} ${script}`], { env });
    expect(result.code).toBe(0);
    const names = JSON.parse(readFileSync(envDump, "utf8")) as string[];
    expect(names).not.toContain("RBW_RESULTS_DEPLOY_KEY_FILE");
    expect(names).not.toContain("RBW_PUBLIC_STORE_TOKEN");
    expect(names.filter((name) => name.startsWith("GIT_"))).toEqual([]);
  });

  it("never copies the pattern file into state, store or remote", async () => {
    const world = createWorld();
    stage(world.staging);
    await publish(world, writeRootRun(world));
    for (const dir of [world.state, world.store]) {
      for (const path of listFiles(dir)) expect(readFileSync(join(dir, path), "utf8")).not.toContain(FORBIDDEN_TERM);
    }
  });
});

describe("scanner command", () => {
  it("resolves a relative script path against the invocation directory", async () => {
    const world = createWorld();
    stage(world.staging);
    const script = relative(process.cwd(), scannerCli);
    expect(script.startsWith("/")).toBe(false);
    const result = await publish(world, writeRootRun(world), ["--scanner", `${process.execPath} ${script}`]);
    expect(result.code).toBe(0);
    expect(printed(result).status).toBe("published");
  });
});
