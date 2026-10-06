import { defineProject } from "vitest/config";

// Unit tests drive a fake Docker command layer and a fake clock; they start no container and use no network.
export default defineProject({
  test: {
    name: "local-runner",
    include: ["test/unit/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
