import { defineProject } from "vitest/config";

// Unit tests use PGlite with every spend migration, the local runner's fake Sandbox SDK and its
// simulated kit image; they start no container and use no network.
export default defineProject({
  test: {
    name: "controller",
    include: ["test/unit/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
