import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { SHARED_MACHINE_TEST_WORKERS } from "../../vitest.workers";

export default defineConfig({
  test: {
    // One `vp test` invocation's share of a shared machine (VC-339).
    ...SHARED_MACHINE_TEST_WORKERS,
    coverage: {
      include: ["src/**"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
