import { defineConfig } from "vitest/config";

// CI sets this path so the counted test run also writes the JSON report that the floor check reads.
const jsonReport = process.env.RBW_VITEST_JSON_REPORT;

export default defineConfig({
  test: {
    reporters: jsonReport ? ["default", "json"] : ["default"],
    outputFile: jsonReport ? { json: jsonReport } : {},
    projects: [
      "packages/*",
      "tools/*",
      { test: { name: "scripts-checks", include: ["scripts/checks/**/*.test.ts"] } },
      // Vitest fails when no project matches; this inline project keeps an empty workspace valid.
      { test: { name: "root", include: ["*.test.ts"] } },
    ],
  },
});
