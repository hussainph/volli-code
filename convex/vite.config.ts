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
    coverage: {
      provider: "v8",
      include: [
        "functions/lib/previewAccess.ts",
        "functions/previewAccess.ts",
        "functions/lib/sponsoredPreview.ts",
        "functions/lib/deploymentChecks.ts",
        "functions/lib/runnerLinkRateLimit.ts",
        "functions/runnerLinkRateLimit.ts",
        "scripts/deploy.ts",
        "scripts/deploy.mjs",
      ],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
    // The move engine's kill/resume matrix runs in ci-extended (`test:matrix`).
    exclude: ["test/**/*.backend.test.ts", "test/**/*.matrix.test.ts"],
  },
});
