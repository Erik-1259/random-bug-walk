import { defineProject } from "vitest/config";

// Unit tests use the local runner's simulated kit image behind a fake Docker, the real publisher
// in local mode with a gitleaks stand-in, and a local private store; no container, no network.
export default defineProject({
  test: {
    name: "release",
    include: ["test/unit/**/*.test.ts"],
    setupFiles: ["test/support/setup.ts"],
    testTimeout: 180_000,
    hookTimeout: 300_000,
  },
});
