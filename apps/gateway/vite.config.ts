import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { SHARED_MACHINE_TEST_WORKERS } from "../../vitest.workers";

export default defineConfig({
  test: {
    // One `vp test` invocation's share of a shared machine (VC-339).
    ...SHARED_MACHINE_TEST_WORKERS,
    // Unit tests run the Worker's modules under plain Node (web platform
    // globals only); `test/worker.test.ts` runs the wrangler-built bundle in
    // workerd through Miniflare.
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      // `index.ts` only binds the global fetch and clock; the workerd test
      // drives it, through the built bundle coverage cannot see.
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
