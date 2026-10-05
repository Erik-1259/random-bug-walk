import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appDatabaseUrl, kitDatabase } from "../../src/database.ts";
import type { FixtureModule, SqlClient } from "../../src/database.ts";

const OWNER_URL = "postgresql://umami_owner@localhost/umami?host=/run/rbw-pg";
const APP_URL = "postgresql://umami_app:synthetic-password@127.0.0.1:5432/umami";

function fakes(options: { failConnect?: Error } = {}) {
  const log: string[] = [];
  const fixture: FixtureModule = {
    TEMPLATE_DATABASE: "rbw_fixture_template",
    createFixtureTemplate: (url) => {
      log.push(`template ${url}`);
      return Promise.resolve();
    },
    resetFixture: (url) => {
      log.push(`reset ${url}`);
      return Promise.resolve();
    },
  };
  const connect = (url: string): SqlClient => ({
    connect: () => {
      log.push(`connect ${url === APP_URL ? "app" : url}`);
      return options.failConnect === undefined ? Promise.resolve() : Promise.reject(options.failConnect);
    },
    query: (sql) => {
      log.push(`query ${sql}`);
      return Promise.resolve();
    },
    end: () => {
      log.push("end");
      return Promise.resolve();
    },
  });
  return { log, db: kitDatabase({ fixture, ownerUrl: OWNER_URL, appUrl: APP_URL, connect }) };
}

describe("fixture database", () => {
  it("copies the migrated database to the template as the owner, and keeps PUBLIC out of the template", async () => {
    const { log, db } = fakes();
    await db.createTemplate();
    expect(log).toEqual([`template ${OWNER_URL}`, `connect ${OWNER_URL}`, 'query REVOKE ALL ON DATABASE "rbw_fixture_template" FROM PUBLIC', "end"]);
  });

  it("recreates the database from the template, then restores the kit's database grants", async () => {
    const { log, db } = fakes();
    await db.reset();
    expect(log).toEqual([
      `reset ${OWNER_URL}`,
      `connect ${OWNER_URL}`,
      'query REVOKE ALL ON DATABASE "umami" FROM PUBLIC',
      'query GRANT CONNECT ON DATABASE "umami" TO "umami_app"',
      "end",
    ]);
  });

  it("checks that the application role can connect and query", async () => {
    const { log, db } = fakes();
    expect(await db.appCanConnect()).toEqual({ ok: true });
    expect(log).toEqual(["connect app", "query SELECT 1", "end"]);
  });

  it("reports a failed application connection by its code, never its message", async () => {
    const error = Object.assign(new Error("password authentication failed for synthetic-password"), { code: "28P01" });
    const { db } = fakes({ failConnect: error });
    const result = await db.appCanConnect();
    expect(result).toEqual({ ok: false, code: "28P01" });
    expect(JSON.stringify(result)).not.toContain("synthetic-password");
  });

  it("reads the application role's connection string from the kit's app environment file", () => {
    const text = readFileSync(new URL("../../../../kit/umami/etc/app.environment", import.meta.url), "utf8");
    const url = new URL(appDatabaseUrl(text));
    expect([url.username, url.hostname, url.port, url.pathname]).toEqual(["umami_app", "127.0.0.1", "5432", "/umami"]);
    expect(() => appDatabaseUrl("TZ=UTC\n")).toThrow(/DATABASE_URL/);
  });
});
