import { defineProject } from "vitest/config";

// Static checks of the race kit overlay. The in-image checks live in bin/rbw-race-selftest.
export default defineProject({
  test: {
    name: "kit-umami-race",
    include: ["test/**/*.test.ts"],
  },
});
