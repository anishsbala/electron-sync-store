import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["packages/*/src/**/*.ts"],
    },
    include: ["packages/*/test/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
