import { defineProject } from "vitest/config";

// Unit tests build archives in memory or in their own temporary directories from the synthetic host; no container, no network.
export default defineProject({
  test: {
    name: "case-package",
    include: ["test/**/*.test.ts"],
  },
});
