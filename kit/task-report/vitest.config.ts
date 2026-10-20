import { defineProject } from "vitest/config";

// Static checks of the kit image definition; the image itself runs only in copies.
export default defineProject({
  test: {
    name: "kit-task-report",
    include: ["test/**/*.test.ts"],
  },
});
