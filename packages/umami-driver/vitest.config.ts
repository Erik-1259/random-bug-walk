import { defineProject } from "vitest/config";

// Unit tests only: an injected process runner, clock and canned Playwright reports, never a real app.
export default defineProject({
  test: {
    name: "umami-driver",
    include: ["test/unit/**/*.test.ts"],
  },
});
