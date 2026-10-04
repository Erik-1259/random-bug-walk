import { describe, expect, it } from "vitest";
import { expiryFor, runCreate } from "../src/create.ts";
import { config, fakeDeps, project } from "./helpers.ts";
import type { RecordedRequest, Reply } from "./helpers.ts";

const NAME = "ci-pr-12-9876543210-1";
const ID = "br-synthetic-1";
const base = `${project}/branches/${ID}`;
const START = Date.parse("2026-10-03T12:00:00Z");

interface Options {
  existing?: string[];
  createStatus?: number;
  password?: string;
  endpoints?: { type: string; host: string }[];
  databases?: { name: string; owner_name: string }[];
  revealStatus?: number;
}

function handlerFor(options: Options) {
  return ({ method, path }: RecordedRequest): Reply => {
    if (method === "GET" && path.startsWith(`${project}/branches?`)) {
      return { status: 200, body: { branches: (options.existing ?? []).map((name, i) => ({ id: `br-old-${String(i)}`, name })) } };
    }
    if (method === "POST" && path === `${project}/branches`) {
      return { status: options.createStatus ?? 201, body: { branch: { id: ID, name: NAME } } };
    }
    if (path === `${base}/roles/neondb_owner/reveal_password`) {
      return options.revealStatus === undefined
        ? { status: 200, body: { password: options.password ?? "synthetic-pw" } }
        : { status: options.revealStatus };
    }
    if (path === `${base}/endpoints`) {
      return { status: 200, body: { endpoints: options.endpoints ?? [{ type: "read_write", host: "ep-a.example.invalid" }, { type: "read_only", host: "ep-b.example.invalid" }] } };
    }
    if (path === `${base}/databases`) {
      return { status: 200, body: { databases: options.databases ?? [{ name: "neondb", owner_name: "neondb_owner" }] } };
    }
    return { status: 404 };
  };
}

async function create(options: Options = {}) {
  const { deps, requests } = fakeDeps(handlerFor(options), START);
  const events: string[] = [];
  const code = await runCreate(deps, config, NAME, {
    stdout: (line) => events.push(`stdout:${line}`),
    stderr: (line) => events.push(`stderr:${line}`),
    output: (key, value) => events.push(`output:${key}=${value}`),
    summary: (text) => events.push(`summary:${text}`),
  });
  return { code, events, requests };
}

const URL_VALUE = "postgresql://neondb_owner:synthetic-pw@ep-a.example.invalid/neondb?sslmode=verify-full";

describe("runCreate", () => {
  it("creates the branch with the per-run name, a four-hour expiry and a read_write endpoint", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const urlOf = (input: Parameters<typeof fetch>[0]): string => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const { deps } = fakeDeps(handlerFor({}), START);
    const original = deps.fetch;
    deps.fetch = (input, init) => {
      if (init?.method === "POST" && typeof init.body === "string") calls.push({ path: urlOf(input), body: JSON.parse(init.body) as unknown });
      return original(input, init);
    };
    await runCreate(deps, config, NAME, { stdout: () => undefined, stderr: () => undefined, output: () => undefined, summary: () => undefined });
    expect(calls).toEqual([
      {
        path: `${config.apiBase}${project}/branches`,
        body: { branch: { name: NAME, expires_at: "2026-10-03T16:00:00Z" }, endpoints: [{ type: "read_write" }] },
      },
    ]);
  });

  it("prints every mask line before any other line, output or summary", async () => {
    const result = await create();
    expect(result.code).toBe(0);
    expect(result.events).toEqual([
      `stdout:::add-mask::${ID}`,
      "stdout:::add-mask::synthetic-pw",
      "stdout:::add-mask::ep-a.example.invalid",
      "stdout:::add-mask::ep-b.example.invalid",
      `stdout:::add-mask::${URL_VALUE}`,
      "output:created=true",
      `output:db_url=${URL_VALUE}`,
      `stdout:Neon branch: ${NAME} (expires 2026-10-03T16:00:00Z)`,
      `summary:### Neon branch\n- name: \`${NAME}\`\n- expires: 2026-10-03T16:00:00Z`,
    ]);
  });

  it("never prints the branch ID, password or host outside add-mask lines", async () => {
    const result = await create();
    const unmasked = result.events.filter((e) => !e.startsWith("stdout:::add-mask::") && !e.startsWith("output:db_url="));
    for (const value of [ID, "synthetic-pw", "ep-a.example.invalid"]) {
      expect(unmasked.join("\n")).not.toContain(value);
    }
  });

  it("masks the URL-encoded password as well and builds the URL from it", async () => {
    const result = await create({ password: "p@ss/w ord" });
    expect(result.events).toContain("stdout:::add-mask::p%40ss%2Fw%20ord");
    const url = result.events.find((e) => e.startsWith("output:db_url="));
    expect(url).toBe("output:db_url=postgresql://neondb_owner:p%40ss%2Fw%20ord@ep-a.example.invalid/neondb?sslmode=verify-full");
  });

  it("requires sslmode=verify-full", async () => {
    const result = await create();
    expect(result.events.find((e) => e.startsWith("output:db_url="))).toContain("sslmode=verify-full");
  });

  it("fails without creating anything when the branch name already exists", async () => {
    const result = await create({ existing: [NAME] });
    expect(result.code).toBe(1);
    expect(result.requests.some((r) => r.method === "POST")).toBe(false);
    expect(result.events.some((e) => e.startsWith("output:"))).toBe(false);
  });

  it("fails after the ID and password masks, without outputs, when there is no read_write endpoint", async () => {
    const result = await create({ endpoints: [] });
    expect(result.code).toBe(1);
    expect(result.events.filter((e) => e.startsWith("output:"))).toEqual([]);
    expect(result.events.slice(0, 2)).toEqual([`stdout:::add-mask::${ID}`, "stdout:::add-mask::synthetic-pw"]);
  });

  it("fails with the ID masked when the password cannot be revealed", async () => {
    const result = await create({ revealStatus: 404 });
    expect(result.code).toBe(1);
    expect(result.events).toEqual([`stdout:::add-mask::${ID}`, "stderr:create: reveal_password request failed (http 404)"]);
  });

  it("fails when the create request is refused and does not retry it", async () => {
    const result = await create({ createStatus: 500 });
    expect(result.code).toBe(1);
    expect(result.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(result.events).toEqual(["stderr:create: create branch request failed (http 500)"]);
  });

  it("uses the only database owned by the role when neondb is absent", async () => {
    const result = await create({ databases: [{ name: "app", owner_name: "neondb_owner" }, { name: "other", owner_name: "someone" }] });
    expect(result.events.find((e) => e.startsWith("output:db_url="))).toContain("/app?");
  });

  it("fails when no database can be chosen unambiguously", async () => {
    const result = await create({ databases: [{ name: "a", owner_name: "neondb_owner" }, { name: "b", owner_name: "neondb_owner" }] });
    expect(result.code).toBe(1);
    expect(result.events.some((e) => e.startsWith("output:"))).toBe(false);
  });
});

describe("expiryFor", () => {
  it("is four hours later in UTC with whole seconds", () => {
    expect(expiryFor(Date.parse("2026-10-03T22:30:15.789Z"))).toBe("2026-10-04T02:30:15Z");
  });
});
