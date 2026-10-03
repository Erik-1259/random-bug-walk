import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      "tools/*",
      // Vitest fails when no project matches; this inline project keeps an empty workspace valid.
      { test: { name: "root", include: ["*.test.ts"] } },
    ],
  },
});
