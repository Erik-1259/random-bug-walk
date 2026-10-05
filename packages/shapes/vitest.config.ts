import { defineProject } from "vitest/config";

// Unit tests only, on synthetic sources. Checks against the pinned upstream files run through `test:upstream`.
export default defineProject({
  test: {
    name: "shapes",
    include: ["test/unit/**/*.test.ts"],
  },
});
