import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // DB テストは直列に実行する（同じスキーマを作り直すため）
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
