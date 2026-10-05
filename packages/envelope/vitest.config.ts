import { defineProject } from "vitest/config";

// Unit tests only. Integration tests need a real Postgres and run through `test:integration`.
export default defineProject({
  test: {
    name: "envelope",
    include: ["test/unit/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
