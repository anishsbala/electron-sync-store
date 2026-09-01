import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["packages/*/src/**/*.ts"],
    },
    include: [
      "packages/*/test/**/*.test.ts",
      "packages/*/test/**/*.test.tsx",
      "tests/**/*.test.ts",
    ],
  },
});
