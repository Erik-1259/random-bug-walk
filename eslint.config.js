import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  // hosts/task-report/app is a vendored baseline that must stay byte-identical (hosts/task-report/SOURCE.md).
  globalIgnores(["**/node_modules/", "**/dist/", "**/build/", "**/coverage/", "**/.next/", "**/next-env.d.ts", "python/", ".venv/", "hosts/task-report/app/"]),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.ts"],
          defaultProject: "tsconfig.base.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
    },
  },
  {
    // Plain JS files (this config) are not part of any TypeScript project.
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
