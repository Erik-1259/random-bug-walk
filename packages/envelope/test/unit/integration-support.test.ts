import { expect, test } from "vitest";
import { createTestClient } from "../integration/support.ts";
import { runIntegration } from "../integration/runner.ts";

test("malformed DATABASE_URL constructor errors are sanitized", () => {
  const synthetic = "postgres://synthetic-user:synthetic-password@example.invalid:bad/synthetic-db";
  expect(() => createTestClient(synthetic)).toThrow("DATABASE_URL failed (driver error code ERR_INVALID_URL)");
  try { createTestClient(synthetic); } catch (error) {
    expect(String(error)).not.toContain(synthetic);
    expect(String(error)).not.toContain("synthetic-password");
  }
});
test("integration worker inherits only DATABASE_URL", () => {
  const synthetic = "postgres://synthetic-user:synthetic-password@example.invalid/synthetic-db";
  const result = runIntegration(synthetic, (command, args, options) => {
    expect(command).toBe(process.execPath);
    expect(args.slice(1)).toEqual(["run", "--config", "vitest.integration.config.ts"]);
    expect(options.env).toEqual({ DATABASE_URL: synthetic });
    return { status: 7 };
  });
  expect(result).toBe(7);
});
