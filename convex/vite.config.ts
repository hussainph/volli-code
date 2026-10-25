import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { SHARED_MACHINE_TEST_WORKERS } from "../vitest.workers";

// Unit tests: functions run in-process under `convex-test`, no backend.
// The real-backend suite is `vite.backend.config.ts` (`test:backend`).
export default defineConfig({
  test: {
    // One `vp test` invocation's share of a shared machine (VC-339).
    ...SHARED_MACHINE_TEST_WORKERS,
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.backend.test.ts"],
  },
});
