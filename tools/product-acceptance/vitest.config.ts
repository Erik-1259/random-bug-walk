import { defineConfig } from "vitest/config";
export default defineConfig({ test: { name: "product-acceptance", include: ["test/**/*.test.ts"] } });
