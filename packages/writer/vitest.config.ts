import { defineProject } from "vitest/config";

// Unit tests only. Integration tests need a real Postgres and run through `test:integration`.
export default defineProject({
  test: {
    name: "writer",
    include: ["test/unit/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
