import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "admission",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
