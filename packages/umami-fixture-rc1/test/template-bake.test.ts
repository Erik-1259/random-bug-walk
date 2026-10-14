import { beforeEach, describe, expect, it, vi } from "vitest";

interface Call {
  database: string;
  text: string;
}

const calls: Call[] = [];

// A fake pg.Client that records which database each statement is sent to. The admin-user check
// answers with one row, and every other statement succeeds.
vi.mock("pg", () => {
  class Client {
    private readonly database: string;
    constructor(config: { connectionString: string }) {
      this.database = decodeURIComponent(new URL(config.connectionString).pathname.slice(1));
    }
    connect(): Promise<void> {
      return Promise.resolve();
    }
    query(text: string): Promise<{ rowCount: number; rows: unknown[] }> {
      calls.push({ database: this.database, text });
      return Promise.resolve({ rowCount: 1, rows: [] });
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { default: { Client } };
});

const { createFixtureTemplate, loadFixture, TEMPLATE_DATABASE, twoFactorSeedStatements } = await import("../src/index.ts");

const APP_URL = "postgres://synthetic-owner:synthetic-password@db.invalid:5432/synthetic_app";
const COPY = `CREATE DATABASE "${TEMPLATE_DATABASE}" TEMPLATE "synthetic_app"`;

describe("createFixtureTemplate", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("bakes every two-factor seed statement into the template copy only, after the copy is made", async () => {
    await createFixtureTemplate(APP_URL);
    const expected = twoFactorSeedStatements(loadFixture()).map((statement) => statement.text);
    const seedTexts = new Set(expected);
    const seeds = calls.map((call, index) => ({ ...call, index })).filter((call) => seedTexts.has(call.text));
    expect(seeds.map((call) => call.text)).toEqual(expected);
    expect(new Set(seeds.map((call) => call.database))).toEqual(new Set([TEMPLATE_DATABASE]));

    const copy = calls.findIndex((call) => call.text === COPY);
    expect(copy).toBeGreaterThanOrEqual(0);
    expect(calls[copy]?.database).toBe("postgres");
    for (const seed of seeds) expect(seed.index).toBeGreaterThan(copy);
  });

  it("sends nothing to the application database, so the original suite sees stock Umami", async () => {
    await createFixtureTemplate(APP_URL);
    expect(calls.filter((call) => call.database === "synthetic_app")).toEqual([]);
  });

  it("checks the admin user and commits the seed in the template database", async () => {
    await createFixtureTemplate(APP_URL);
    const inTemplate = calls.filter((call) => call.database === TEMPLATE_DATABASE).map((call) => call.text);
    expect(inTemplate[0]).toMatch(/^SELECT 1 FROM "user"/);
    expect(inTemplate[1]).toBe("BEGIN");
    expect(inTemplate.at(-1)).toBe("COMMIT");
  });

  it("bakes into a custom template name when one is given", async () => {
    await createFixtureTemplate(APP_URL, "synthetic_template");
    const seedTexts = new Set(twoFactorSeedStatements(loadFixture()).map((statement) => statement.text));
    expect(new Set(calls.filter((call) => seedTexts.has(call.text)).map((call) => call.database))).toEqual(new Set(["synthetic_template"]));
  });
});
