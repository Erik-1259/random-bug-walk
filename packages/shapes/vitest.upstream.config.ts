import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/upstream/**/*.test.ts"],
    testTimeout: 60_000,
    reporters: ["verbose"],
  },
});
