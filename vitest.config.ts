import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts", "plugin/test/**/*.test.ts", "shared/test/**/*.test.ts"],
    testTimeout: 20000,
  },
});
