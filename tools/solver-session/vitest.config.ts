import { defineProject } from "vitest/config";

// Unit tests drive a fake Docker command layer (the local runner's synthetic kit inputs) and run
// the real reset scripts and the kit's rbw-check-cold with /bin/sh against a temporary tree; they
// start no container and use no network.
export default defineProject({
  test: {
    name: "solver-session",
    include: ["test/unit/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
