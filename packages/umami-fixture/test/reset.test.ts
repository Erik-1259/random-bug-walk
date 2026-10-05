import { describe, expect, it } from "vitest";
import { createFixtureTemplate, resetFixture } from "../src/index.ts";

// The reset itself needs a Postgres server and is proven by the reset study. These tests cover
// the argument checks, which run before any connection is opened.
describe("resetFixture and createFixtureTemplate", () => {
  it.each([
    ["the maintenance database", "postgres://synthetic-user:synthetic-password@db.invalid:5432/postgres"],
    ["no database", "postgres://synthetic-user:synthetic-password@db.invalid:5432"],
  ])("refuse a connection string naming %s", async (_name, connectionString) => {
    await expect(resetFixture(connectionString)).rejects.toThrow(/application database/);
    await expect(createFixtureTemplate(connectionString)).rejects.toThrow(/application database/);
  });

  it("never echoes the connection string in that error", async () => {
    await expect(resetFixture("postgres://synthetic-user:synthetic-password@db.invalid:5432/postgres")).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("synthetic-password") as unknown }),
    );
  });
});
