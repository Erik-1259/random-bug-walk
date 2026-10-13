import { defineProject } from "vitest/config";

// Unit tests use a synthetic host tree with fake site finders and screens; no model, no network.
export default defineProject({
  test: {
    name: "candidates",
    include: ["test/**/*.test.ts"],
  },
});
