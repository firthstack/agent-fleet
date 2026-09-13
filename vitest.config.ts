import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "web/**/*.test.tsx"],
    environment: "node",
    reporters: "default",
    testTimeout: 10_000,
  },
});
