import { defineProject } from "vitest/config";

// Unit tests verify synthetic archive pairs in their own temporary directories; no container, no network.
export default defineProject({
  test: {
    name: "case-validate",
    include: ["test/**/*.test.ts"],
  },
});
