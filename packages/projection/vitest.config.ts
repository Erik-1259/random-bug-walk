import { defineProject } from "vitest/config";

// Tests build synthetic git repositories and copies under a temporary directory; no network.
export default defineProject({
  test: {
    name: "projection",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
