import { describe, expect, it } from "vitest";
import { createFixtureTemplate, loadFixture, resetFixture, TEMPLATE_DATABASE, twoFactorSeedStatements } from "../src/index.ts";

// The reset itself needs a Postgres server and is proven in a live kit copy. These tests cover
// the argument checks, which run before any connection is opened, and the seed statements.
describe("resetFixture and createFixtureTemplate", () => {
  it.each([
    ["the maintenance database", "postgres://synthetic-user:synthetic-password@db.invalid:5432/postgres"],
    ["no database", "postgres://synthetic-user:synthetic-password@db.invalid:5432"],
  ])("refuse a connection string naming %s", async (_name, connectionString) => {
    await expect(resetFixture(connectionString)).rejects.toThrow(/application database/);
    await expect(createFixtureTemplate(connectionString)).rejects.toThrow(/application database/);
  });

  it("never echoes the connection string in that error", async () => {
    await expect(createFixtureTemplate("postgres://synthetic-user:synthetic-password@db.invalid:5432/postgres")).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("synthetic-password") as unknown }),
    );
  });

  it("uses the template name the kit already grants and revokes", () => {
    expect(TEMPLATE_DATABASE).toBe("rbw_fixture_template");
  });
});

describe("twoFactorSeedStatements", () => {
  const fixture = loadFixture();
  const statements = twoFactorSeedStatements(fixture);
  const userId = fixture.two_factor.user_id;

  it("clears any two-factor rows of the admin user before inserting", () => {
    expect(statements.slice(0, 4)).toEqual([
      { text: "DELETE FROM two_factor_backup_code WHERE user_id = $1", values: [userId] },
      { text: "DELETE FROM two_factor_rate_limit WHERE user_id = $1", values: [userId] },
      { text: "DELETE FROM two_factor_otp_used WHERE user_id = $1", values: [userId] },
      { text: "DELETE FROM two_factor_auth WHERE user_id = $1", values: [userId] },
    ]);
  });

  it("enables two-factor sign-in with a synthetic, unused TOTP column", () => {
    expect(statements[4]).toEqual({
      text: "INSERT INTO two_factor_auth (id, user_id, secret, is_enabled, updated_at) VALUES ($1, $2, $3, true, CURRENT_TIMESTAMP)",
      values: ["synthetic-rc1-two-factor", userId, "synthetic-rc1-totp-column-unused"],
    });
  });

  it("inserts every backup code unused, in data-file order, as its hash only", () => {
    const inserts = statements.slice(5);
    expect(inserts).toHaveLength(10);
    expect(inserts.map((statement) => statement.values)).toEqual(fixture.two_factor.backup_codes.map((code) => [code.id, userId, code.code_hash]));
    expect(new Set(inserts.map((statement) => statement.text))).toEqual(new Set(["INSERT INTO two_factor_backup_code (id, user_id, code_hash, used) VALUES ($1, $2, $3, false)"]));
    expect(JSON.stringify(statements)).not.toContain("SYNTHETIC-RC1-CODE");
  });
});
