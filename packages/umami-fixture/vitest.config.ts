import { defineProject } from "vitest/config";

// Unit tests only. The Playwright checks are named *.check.ts and never collected here.
export default defineProject({
  test: {
    name: "umami-fixture",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
