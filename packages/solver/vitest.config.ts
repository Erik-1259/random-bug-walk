import { defineProject } from "vitest/config";

// Unit tests only: PGlite with the @rbw/spend migrations, a scripted fetch and fake session tools.
// No network.
export default defineProject({
  test: {
    name: "solver",
    include: ["test/unit/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
