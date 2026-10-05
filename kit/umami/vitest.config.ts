import { defineProject } from "vitest/config";

// Static checks of the kit image definition. The in-image checks live in bin/rbw-kit-selftest.
export default defineProject({
  test: {
    name: "kit-umami",
    include: ["test/**/*.test.ts"],
  },
});
