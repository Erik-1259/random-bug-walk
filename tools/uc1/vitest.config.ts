import { defineProject } from "vitest/config";

// Unit tests run the orchestrator with its dry-run dependencies: a scripted model, fake sessions,
// a fake controller and a PGlite spend ledger. They start no container, no controller process and
// use no network.
export default defineProject({
  test: {
    name: "uc1",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
