import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PACKAGE_DIR = new URL("..", import.meta.url).pathname;
const PROJECT = "synthetic-project-1";
const KEY = "synthetic-key";

interface Fake {
  server: Server;
  base: string;
  requests: string[];
  branches: Record<string, unknown>[];
  deleteStatus: number;
}

let fake: Fake;

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

beforeEach(async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    fake.requests.push(`${req.method ?? ""} ${url.pathname}`);
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${KEY}`) { reply(401, {}); return; }
    const prefix = `/api/v2/projects/${PROJECT}`;
    if (req.method === "GET" && url.pathname === `${prefix}/branches`) { reply(200, { branches: fake.branches }); return; }
    if (req.method === "DELETE" && url.pathname.startsWith(`${prefix}/branches/`)) { reply(fake.deleteStatus, {}); return; }
    if (url.pathname.endsWith("/reveal_password")) { reply(200, { password: "synthetic-pw" }); return; }
    if (url.pathname.endsWith("/endpoints")) { reply(200, { endpoints: [{ type: "read_write", host: "ep.example.invalid" }] }); return; }
    reply(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  fake = { server, base: `http://127.0.0.1:${String(port)}/api/v2`, requests: [], branches: [], deleteStatus: 200 };
});

afterEach(async () => {
  await new Promise<void>((resolve) => fake.server.close(() => { resolve(); }));
});

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], env: Record<string, string> = { NEON_API_KEY: KEY, NEON_PROJECT_ID: PROJECT }): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli.ts", ...args], {
      cwd: PACKAGE_DIR,
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => { resolve({ code, stdout, stderr }); });
  });
}

describe("cli branch-name", () => {
  it("prints the per-run name", async () => {
    const result = await cli(["branch-name", "--pr", "12", "--run-id", "9876543210", "--run-attempt", "2"], {});
    expect(result).toMatchObject({ code: 0, stdout: "ci-pr-12-9876543210-2\n" });
  });

  it("exits 2 for a leading-zero pull request number", async () => {
    const result = await cli(["branch-name", "--pr", "012", "--run-id", "9876543210", "--run-attempt", "2"], {});
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
  });
});

describe("cli delete", () => {
  it("exits 0 and sends one DELETE by ID", async () => {
    const result = await cli(["delete", "--name", "ci-pr-1-2-3", "--id", "br-synthetic-1", "--api-base", fake.base]);
    expect(result).toMatchObject({ code: 0, stdout: "outcome=deleted name=ci-pr-1-2-3 id=masked\n" });
    expect(fake.requests).toEqual([`DELETE /api/v2/projects/${PROJECT}/branches/br-synthetic-1`]);
  });

  it("falls back to the name when no ID is given", async () => {
    fake.branches.push({ id: "br-by-name-1", name: "ci-pr-1-2-3", created_at: minutesAgo(1) });
    const result = await cli(["delete", "--name", "ci-pr-1-2-3", "--api-base", fake.base]);
    expect(result.code).toBe(0);
    expect(fake.requests.at(-1)).toBe(`DELETE /api/v2/projects/${PROJECT}/branches/br-by-name-1`);
  });

  it("exits 1 when the branch stays listed after a refused delete", async () => {
    fake.branches.push({ id: "br-synthetic-1", name: "ci-pr-1-2-3" });
    fake.deleteStatus = 403;
    const result = await cli(["delete", "--name", "ci-pr-1-2-3", "--id", "br-synthetic-1", "--api-base", fake.base]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("outcome=leaked");
  });

  it("exits 2 for an invalid ID without sending a request", async () => {
    const result = await cli(["delete", "--name", "ci-pr-1-2-3", "--id", "not-an-id", "--api-base", fake.base]);
    expect(result.code).toBe(2);
    expect(fake.requests).toEqual([]);
  });

  it("exits 2 for a name outside the CI pattern without sending a request", async () => {
    const result = await cli(["delete", "--name", "preview/feature-x", "--api-base", fake.base]);
    expect(result.code).toBe(2);
    expect(fake.requests).toEqual([]);
  });

  it("never prints the API key", async () => {
    const result = await cli(["delete", "--name", "ci-pr-1-2-3", "--id", "br-synthetic-1", "--api-base", fake.base]);
    expect(result.stdout + result.stderr).not.toContain(KEY);
  });
});

describe("cli sweep", () => {
  beforeEach(() => {
    fake.branches.push(
      { id: "br-old-1", name: "ci-pr-7-100-1", created_at: minutesAgo(180) },
      { id: "br-young-1", name: "ci-pr-7-101-1", created_at: minutesAgo(5) },
      { id: "br-keep-1", name: "ci-keep", created_at: minutesAgo(900) },
      { id: "br-main-1", name: "main", default: true, created_at: minutesAgo(900) },
    );
  });

  it("--dry-run lists would-delete and sends no DELETE", async () => {
    const result = await cli(["sweep", "--min-age-minutes", "120", "--dry-run", "--api-base", fake.base]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("name=ci-pr-7-100-1 age_minutes=180 outcome=would-delete");
    expect(result.stdout).not.toContain("br-old-1");
    expect(fake.requests.some((r) => r.startsWith("DELETE"))).toBe(false);
  });

  it("deletes exactly the selected IDs", async () => {
    const result = await cli(["sweep", "--min-age-minutes", "120", "--api-base", fake.base]);
    expect(result.code).toBe(0);
    expect(fake.requests.filter((r) => r.startsWith("DELETE"))).toEqual([`DELETE /api/v2/projects/${PROJECT}/branches/br-old-1`]);
  });

  it("exits 2 for an invalid minimum age", async () => {
    const result = await cli(["sweep", "--min-age-minutes", "-1", "--api-base", fake.base]);
    expect(result.code).toBe(2);
    expect(fake.requests).toEqual([]);
  });

  it("exits 2 when a matching branch has no created_at", async () => {
    fake.branches.push({ id: "br-nodate-1", name: "ci-pr-7-103-1" });
    const result = await cli(["sweep", "--min-age-minutes", "120", "--dry-run", "--api-base", fake.base]);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("name=ci-pr-7-103-1 age_minutes=- outcome=unknown");
  });
});

describe("cli list", () => {
  it("prints only CI branches with name, id, created_at and expires_at", async () => {
    fake.branches.push(
      { id: "br-a-1", name: "ci-pr-1-2-3", created_at: "2026-10-03T09:00:00Z", expires_at: "2026-10-03T13:00:00Z" },
      { id: "br-b-1", name: "ci-keep" },
    );
    const result = await cli(["list", "--api-base", fake.base]);
    expect(result).toMatchObject({ code: 0, stdout: "ci-pr-1-2-3\tbr-a-1\t2026-10-03T09:00:00Z\t2026-10-03T13:00:00Z\n" });
  });
});

describe("cli create", () => {
  const NAME = "ci-pr-12-9876543210-1";
  let outputFile: string;

  beforeEach(() => {
    outputFile = join(mkdtempSync(join(tmpdir(), "neon-ci-")), "output");
    writeFileSync(outputFile, "");
    const base = `/api/v2/projects/${PROJECT}`;
    const handler = fake.server.listeners("request")[0] as (req: IncomingMessage, res: ServerResponse) => void;
    fake.server.removeAllListeners("request");
    fake.server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.method === "POST" && url.pathname === `${base}/branches`) { fake.requests.push(`POST ${url.pathname}`); json(201, { branch: { id: "br-created-1", name: NAME } }); return; }
      if (url.pathname === `${base}/branches/br-created-1/databases`) { fake.requests.push(`GET ${url.pathname}`); json(200, { databases: [{ name: "neondb", owner_name: "neondb_owner" }] }); return; }
      handler(req, res);
    });
  });

  it("writes created and db_url to GITHUB_OUTPUT and only add-mask lines before them", async () => {
    const result = await cli(["create", "--name", NAME, "--api-base", fake.base], { NEON_API_KEY: KEY, NEON_PROJECT_ID: PROJECT, GITHUB_OUTPUT: outputFile });
    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines.slice(0, 4)).toEqual([
      "::add-mask::br-created-1",
      "::add-mask::synthetic-pw",
      "::add-mask::ep.example.invalid",
      "::add-mask::postgresql://neondb_owner:synthetic-pw@ep.example.invalid/neondb?sslmode=verify-full",
    ]);
    expect(lines[4]).toMatch(new RegExp(`^Neon branch: ${NAME} \\(expires \\d{4}-`));
    expect(lines).toHaveLength(5);
    expect(readFileSync(outputFile, "utf8")).toBe(
      "created=true\ndb_url=postgresql://neondb_owner:synthetic-pw@ep.example.invalid/neondb?sslmode=verify-full\n",
    );
    expect(result.stderr).toBe("");
  });

  it("exits 2 without a request for a name outside the CI pattern or a missing GITHUB_OUTPUT", async () => {
    const env = { NEON_API_KEY: KEY, NEON_PROJECT_ID: PROJECT, GITHUB_OUTPUT: outputFile };
    expect((await cli(["create", "--name", "main", "--api-base", fake.base], env)).code).toBe(2);
    expect((await cli(["create", "--name", NAME, "--api-base", fake.base], { NEON_API_KEY: KEY, NEON_PROJECT_ID: PROJECT })).code).toBe(2);
    expect(fake.requests).toEqual([]);
  });
});

describe("cli mask", () => {
  it("writes only add-mask lines on stdout and nothing on stderr", async () => {
    const result = await cli(["mask", "--id", "br-synthetic-1", "--api-base", fake.base]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("::add-mask::br-synthetic-1\n::add-mask::synthetic-pw\n::add-mask::ep.example.invalid\n");
    expect(result.stderr).toBe("");
  });

  it("exits 2 for a missing ID without sending a request", async () => {
    expect((await cli(["mask", "--api-base", fake.base])).code).toBe(2);
    expect(fake.requests).toEqual([]);
  });
});

describe("missing configuration", () => {
  it.each([
    ["create", "--name", "ci-pr-1-2-3"],
    ["mask", "--id", "br-synthetic-1"],
    ["delete", "--name", "ci-pr-1-2-3"],
    ["sweep", "--min-age-minutes", "120"],
    ["list"],
  ])("%s exits 2, names what is missing and sends no request", async (...args) => {
    const result = await cli([...args, "--api-base", fake.base], {});
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("NEON_API_KEY");
    expect(result.stderr).toContain("NEON_PROJECT_ID");
    expect(fake.requests).toEqual([]);
  });

  it("names only the missing variable", async () => {
    const result = await cli(["list", "--api-base", fake.base], { NEON_API_KEY: KEY });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("NEON_PROJECT_ID");
    expect(result.stderr).not.toContain("missing configuration: NEON_API_KEY");
  });
});

describe("--api-base", () => {
  it("rejects plain http on a non-loopback host", async () => {
    const result = await cli(["list", "--api-base", "http://example.invalid/api/v2"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--api-base");
  });
});
