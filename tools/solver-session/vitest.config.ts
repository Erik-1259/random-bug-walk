import { defineProject } from "vitest/config";

// Unit tests write temporary files only; they start no container, no controller process and use no network.
export default defineProject({
  test: {
    name: "solver-session",
    include: ["test/**/*.test.ts"],
  },
});
