import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openTestDatabase } from "../integration/support.ts";

const SYNTHETIC_URL = "postgres://synthetic-user:synthetic-secret@127.0.0.1:9/synthetic-db";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("integration test setup", () => {
  it("never puts any part of DATABASE_URL into its connection error", async () => {
    vi.stubEnv("DATABASE_URL", SYNTHETIC_URL);
    const error: unknown = await openTestDatabase().then(
      () => new Error("expected the connection to fail"),
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    // Every property, hidden ones and causes included.
    const text = inspect(error, { showHidden: true, depth: 5 });
    expect(text).toContain("DATABASE_URL");
    // The port is not checked on its own: the stack holds line:column pairs such as ":9".
    for (const part of ["synthetic-user", "synthetic-secret", "127.0.0.1", "synthetic-db"]) {
      expect(text).not.toContain(part);
    }
  });
});
