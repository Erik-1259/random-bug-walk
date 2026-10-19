import { defineProject } from "vitest/config";

// Unit tests only: synthetic trial records, the committed data and catalog files and the vendored
// baseline, never a running app or database.
export default defineProject({
  test: {
    name: "host-task-report",
    include: ["test/**/*.test.ts"],
  },
});
