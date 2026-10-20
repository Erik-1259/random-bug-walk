import { defineProject } from "vitest/config";

// The tests use synthetic prepared stores and record sets in temporary directories; they start no
// container and use no network. Tests that need the real prepared store or published record sets
// are skipped unless RBW_UMAMI_STORE or RBW_UMAMI_RECORDS_DIR names one.
export default defineProject({
  test: {
    name: "host-umami",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
