import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// Vitest re-reads this AFTER config/CLI resolution. An ambient Session budget
// (even with --maxWorkers=1) must not parallelize one deployment's env and quotas.
process.env["VITEST_MAX_WORKERS"] = "1";

// Integration tests against ONE real pinned local backend, started by the
// global setup for the whole run and stopped after it. Files share that
// backend, so each test uses its own user/ids rather than a clean database.
export default defineConfig({
  test: {
    include: ["test/**/*.backend.test.ts"],
    globalSetup: ["fixture/global-setup.ts"],
    setupFiles: ["test/backend-setup.ts"],
    // Quota resets and file-scoped VOLLI_S3_* settings share this deployment.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
