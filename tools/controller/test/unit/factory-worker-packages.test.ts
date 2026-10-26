// The worker image's build runs kit/factory-worker/check-packages.mjs on its prepared directory. These
// tests run that script as a child process against a directory the real exporter wrote (the
// synthetic host's one entry), then against copies broken one way each.
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { preparedObjectName } from "@rbw/case-package";
import { scratch, syntheticHost } from "./factory-wiring-fakes.ts";
import type { SyntheticHost } from "./factory-wiring-fakes.ts";

const CHECK = fileURLToPath(new URL("../../../../kit/factory-worker/check-packages.mjs", import.meta.url));

interface Checked {
  code: number | null;
  stdout: string;
  stderr: string;
}

function check(...args: string[]): Promise<Checked> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CHECK, ...args], (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stdout, stderr });
    });
  });
}

describe("the worker image's prepared-package check", () => {
  let host: SyntheticHost;

  beforeAll(async () => {
    host = await syntheticHost();
  });

  /** A fresh copy of the exporter's prepared directory. */
  async function prepared(): Promise<string> {
    const dir = join(await scratch("packages"), "packages");
    await cp(host.packagesDir, dir, { recursive: true });
    return dir;
  }

  it("accepts the directory the exporter wrote", async () => {
    const result = await check(await prepared());
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("refuses a directory without index.json", async () => {
    const dir = await prepared();
    await unlink(join(dir, "index.json"));
    const result = await check(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no index\.json/);
  });

  it("refuses an index that lists no entries", async () => {
    const dir = await prepared();
    const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8")) as { entries: unknown[] };
    await writeFile(join(dir, "index.json"), JSON.stringify({ ...index, entries: [] }));
    const result = await check(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no entries/);
  });

  it("refuses an archive whose bytes do not match its sha256 name", async () => {
    const dir = await prepared();
    const name = preparedObjectName(host.prepared.bug_case_sha256);
    await writeFile(join(dir, name), new Uint8Array([...host.bug_case, 0]));
    const result = await check(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/hash/);
    expect(result.stderr).toContain(name);
  });

  it.each(["bug_case_sha256", "validator_core_sha256"] as const)("refuses an entry whose %s archive is missing", async (part) => {
    const dir = await prepared();
    const name = preparedObjectName(host.prepared[part]);
    await unlink(join(dir, name));
    const result = await check(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(part);
    expect(result.stderr).toContain(name);
  });

  it("refuses an archive that is a symlink, even to the right bytes", async () => {
    const dir = await prepared();
    const name = preparedObjectName(host.prepared.bug_case_sha256);
    const outside = join(await scratch("outside"), name);
    await rename(join(dir, name), outside);
    await symlink(outside, join(dir, name));
    const result = await check(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/regular file/);
    expect(result.stderr).toContain(name);
  });

  it("refuses a subdirectory", async () => {
    const dir = await prepared();
    await mkdir(join(dir, "nested"));
    const result = await check(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/regular file/);
    expect(result.stderr).toContain("nested");
  });

  it("exits 2 with its usage when no directory is named", async () => {
    const result = await check();
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/usage/);
  });
});
