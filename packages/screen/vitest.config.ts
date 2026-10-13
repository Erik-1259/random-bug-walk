import { defineProject } from "vitest/config";

// Unit tests only: PGlite with the spend migrations, a scripted fake model and synthetic trees. No network.
export default defineProject({
  test: {
    name: "screen",
    include: ["test/unit/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
