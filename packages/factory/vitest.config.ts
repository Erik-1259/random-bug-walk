import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "factory",
    include: ["test/**/*.test.ts"],
  },
});
