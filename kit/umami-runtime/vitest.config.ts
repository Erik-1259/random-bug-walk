import { defineProject } from "vitest/config";

// Static checks of the runtime image definition. The in-image checks live in bin/rbw-runtime-selftest.
export default defineProject({
  test: {
    name: "kit-umami-runtime",
    include: ["test/**/*.test.ts"],
  },
});
