import { defineProject } from "vitest/config";

// Unit tests read the committed fixtures and temporary copies of them; the build test runs next build.
export default defineProject({
  test: {
    name: "web",
    include: ["test/**/*.test.{ts,tsx}"],
    testTimeout: 60_000,
  },
});
