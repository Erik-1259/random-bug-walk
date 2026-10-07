import { defineProject } from "vitest/config";

// Unit tests only, on committed synthetic frozen responses. No test reaches the network.
export default defineProject({
  test: {
    name: "harvest",
    include: ["test/unit/**/*.test.ts"],
  },
});
