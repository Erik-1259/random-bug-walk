import { defineProject } from "vitest/config";

// Unit tests only: PGlite, the replay fetch and committed synthetic recordings. No network.
export default defineProject({
  test: {
    name: "harvest-review",
    include: ["test/unit/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
