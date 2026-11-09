import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globals: true,
    include: ["scripts/graph-checkpointer.contract.test.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
